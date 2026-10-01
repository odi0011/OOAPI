"""Track reconciled fills and associate conditional orders with executed orders."""
from alembic import op
import sqlalchemy as sa

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("orders", sa.Column("reconciled_quantity", sa.Numeric(24, 8), nullable=False, server_default="0"))
    op.add_column("order_fills", sa.Column("quantity", sa.Numeric(24, 8), nullable=False, server_default="0"))
    op.add_column("protection_orders", sa.Column("executed_order_id", sa.Integer(), nullable=True))
    op.create_foreign_key("fk_protection_executed_order", "protection_orders", "orders", ["executed_order_id"], ["id"])


def downgrade():
    op.drop_constraint("fk_protection_executed_order", "protection_orders", type_="foreignkey")
    op.drop_column("protection_orders", "executed_order_id")
    op.drop_column("order_fills", "quantity")
    op.drop_column("orders", "reconciled_quantity")
