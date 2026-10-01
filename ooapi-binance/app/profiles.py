from types import SimpleNamespace
from .config import settings
from .db import SessionLocal
from .models import TradingProfile


def profile_for(owner_id):
    if not settings.ooapi_mode:
        return SimpleNamespace(allow_live_trading=settings.allow_live_trading, proxy_url=settings.proxy_url)
    with SessionLocal() as db:
        profile = db.get(TradingProfile, owner_id) if owner_id else None
        return SimpleNamespace(allow_live_trading=bool(profile and profile.allow_live_trading), proxy_url=profile.proxy_url if profile else "")


def live_allowed(account):
    return account.allow_live_trading and profile_for(account.owner_id).allow_live_trading
