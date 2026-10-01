"""Isolate trading accounts and settings by authenticated OOAPI user."""
from alembic import op
import sqlalchemy as sa

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("exchange_accounts", sa.Column("owner_id", sa.Integer(), nullable=True))
    op.create_index("ix_exchange_accounts_owner_id", "exchange_accounts", ["owner_id"])
    op.create_table("trading_profiles",
        sa.Column("owner_id", sa.Integer(), primary_key=True),
        sa.Column("allow_live_trading", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("proxy_url", sa.String(300), nullable=False, server_default=""))


def downgrade():
    op.drop_table("trading_profiles")
    op.drop_index("ix_exchange_accounts_owner_id", table_name="exchange_accounts")
    op.drop_column("exchange_accounts", "owner_id")
