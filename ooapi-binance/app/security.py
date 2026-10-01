import base64
import hashlib
import secrets
from pathlib import Path
from types import SimpleNamespace
from datetime import timedelta
from fastapi import Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from cryptography.fernet import Fernet

from .config import settings
from .db import get_db
from .models import LoginSession, User


def _fernet() -> Fernet:
    digest = hashlib.sha256(settings.secret_key.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt(value: str) -> str:
    return _fernet().encrypt(value.encode()).decode()


def decrypt(value: str) -> str:
    return _fernet().decrypt(value.encode()).decode()


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    value = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
    return f"{salt}:{value}"


def verify_password(password: str, encoded: str) -> bool:
    salt, expected = encoded.split(":")
    actual = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
    return secrets.compare_digest(actual, expected)


def new_session(db: Session, user: User, response: Response) -> str:
    from .services import utcnow
    token = secrets.token_urlsafe(32)
    csrf = secrets.token_hex(32)
    db.add(LoginSession(user_id=user.id, token_hash=hashlib.sha256(token.encode()).hexdigest(), csrf_token=csrf, expires_at=utcnow() + timedelta(hours=settings.session_hours)))
    db.commit()
    response.set_cookie("qp_session", token, httponly=True, samesite="strict", max_age=settings.session_hours * 3600, secure=settings.app_env != "local")
    return csrf


def require_user(request: Request, db: Session = Depends(get_db)) -> User:
    if settings.ooapi_mode:
        # 引擎只绑定回环地址；身份由 OOAPI 的 authRequired 判定。
        # 错误/缺失的服务凭据不退回旧 Cookie 登录，避免旁路权限边界。
        try:
            key = Path(settings.ooapi_bridge_key_file).read_text(encoding="utf-8").strip()
        except OSError:
            raise HTTPException(503, "OOAPI 服务凭据未配置")
        if len(key) < 32 or not secrets.compare_digest(request.headers.get("X-OOAPI-Bridge", ""), key):
            raise HTTPException(401, "需要 OOAPI 服务认证")
        try:
            owner_id = int(request.headers.get("X-OOAPI-User", "0"))
        except ValueError:
            raise HTTPException(401, "OOAPI 用户身份无效")
        if owner_id <= 0:
            raise HTTPException(401, "OOAPI 用户身份无效")
        db.info["owner_id"] = owner_id
        # 旧端点的 admin 是交易权限，不等同于 OOAPI 平台管理员；各用户管理自己的资产。
        return SimpleNamespace(id=owner_id, username="OOAPI", role="admin")
    from .services import utcnow
    token = request.cookies.get("qp_session", "")
    session = db.scalars(select(LoginSession).where(LoginSession.token_hash == hashlib.sha256(token.encode()).hexdigest(), LoginSession.expires_at > utcnow())).first()
    if not session:
        raise HTTPException(401, "请登录")
    if request.method not in ("GET", "HEAD", "OPTIONS") and not secrets.compare_digest(request.headers.get("X-CSRF-Token", ""), session.csrf_token):
        raise HTTPException(403, "无效的请求令牌")
    user = db.get(User, session.user_id)
    if request.method not in ("GET", "HEAD", "OPTIONS") and user.role != "admin" and request.url.path not in ("/api/auth/logout", "/api/auth/password"):
        raise HTTPException(403, "只读用户不能修改交易设置")
    return user
