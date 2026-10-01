from collections.abc import Generator

from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker, with_loader_criteria

from .config import settings


class Base(DeclarativeBase):
    pass


engine_kwargs = {"pool_pre_ping": True, "hide_parameters": True}
if settings.database_url.startswith("sqlite"):
    engine_kwargs["connect_args"] = {"check_same_thread": False}
else:
    engine_kwargs["pool_recycle"] = 1800
    engine_kwargs["isolation_level"] = "READ COMMITTED"
engine = create_engine(settings.database_url, **engine_kwargs)
if engine.dialect.name == "mysql":
    @event.listens_for(engine, "connect")
    def set_utc(dbapi_connection, _):
        with dbapi_connection.cursor() as cursor:
            cursor.execute("SET time_zone = '+00:00'")
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


@event.listens_for(Session, "do_orm_execute")
def isolate_ooapi_user(execute_state):
    owner_id = execute_state.session.info.get("owner_id")
    if owner_id is None or not execute_state.is_select:
        return
    from .models import ExchangeAccount, AccountSnapshot, Position, RiskConfig, Strategy, Order, ProtectionOrder, BacktestRun, StrategyEvent, OrderFill, TradingProfile
    accounts = select(ExchangeAccount.id).where(ExchangeAccount.owner_id == owner_id)
    strategies = select(Strategy.id).where(Strategy.account_id.in_(accounts))
    orders = select(Order.id).where(Order.account_id.in_(accounts))
    criteria = [(ExchangeAccount, ExchangeAccount.owner_id == owner_id), (TradingProfile, TradingProfile.owner_id == owner_id)]
    criteria += [(model, model.account_id.in_(accounts)) for model in (AccountSnapshot, Position, RiskConfig, Strategy, Order, ProtectionOrder)]
    criteria += [(model, model.strategy_id.in_(strategies)) for model in (BacktestRun, StrategyEvent)]
    criteria.append((OrderFill, OrderFill.order_id.in_(orders)))
    # 包括 db.get、列表、select(列) 与子查询，避免某个新增端点遗漏 ownership 条件。
    execute_state.statement = execute_state.statement.options(*[with_loader_criteria(model, clause, include_aliases=True) for model, clause in criteria])


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
