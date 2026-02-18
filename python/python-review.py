from fastapi import FastAPI, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy import select, update, insert, String, Integer, DateTime
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from pydantic import BaseModel
from typing import Dict, Any
from datetime import datetime
import httpx
import structlog

logger = structlog.get_logger()

app = FastAPI()

class Base(DeclarativeBase):
    pass

class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(100))
    email: Mapped[str] = mapped_column(String(255))


class UserSetting(Base):
    __tablename__ = "user_settings"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer)
    setting_key: Mapped[str] = mapped_column(String(100))
    setting_value: Mapped[str] = mapped_column(String(500))
    updated_at: Mapped[datetime] = mapped_column(DateTime)


# Database setup
engine = create_async_engine("postgresql+asyncpg://admin:adminpassword@localhost:5432/userdb")
AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False)


async def get_db():
    async with AsyncSessionLocal() as session:
        yield session


# Global HTTP client
http_client = httpx.AsyncClient(timeout=5.0)


class SettingsUpdate(BaseModel):
    settings: Dict[str, Any]


class SettingsService:
    """Service for managing user settings"""

    def __init__(self, db: AsyncSession):
        self.db = db
        self.external_api_url = "https://preferences.example.com"

    async def get_settings(self, user_id: int) -> Dict[str, Any]:
        # Get user
        user_result = await self.db.execute(
            select(User).where(User.id == user_id)
        )
        user = user_result.scalar_one_or_none()

        if not user:
            raise HTTPException(status_code=404, detail="User not found")

        # Get all settings
        settings_result = await self.db.execute(
            select(UserSetting).where(UserSetting.user_id == user_id)
        )
        settings = settings_result.scalars().all()

        settings_dict = {s.setting_key: s.setting_value for s in settings}

        return {
            "user_id": user.id,
            "username": user.username,
            "email": user.email,
            "settings": settings_dict
        }

    async def update_settings(self, user_id: int, settings: Dict[str, Any]) -> Dict[str, Any]:
        # Get user
        user_result = await self.db.execute(
            select(User).where(User.id == user_id)
        )
        user = user_result.scalar_one_or_none()

        if not user:
            raise HTTPException(status_code=404, detail="User not found")

        # Update or insert each setting
        updated = []
        for key, value in settings.items():
            stmt = pg_insert(UserSetting).values(
                user_id=user_id,
                setting_key=key,
                setting_value=str(value)
            ).on_conflict_do_update(
                index_elements=['user_id', 'setting_key'],
                set_={'setting_value': str(value), 'updated_at': 'NOW()'}
            )
            await self.db.execute(stmt)
            updated.append({"key": key, "value": value})

        await self.db.commit()

        # Sync settings to external preferences service
        for setting in updated:
            try:
                await http_client.post(
                    f"{self.external_api_url}/sync",
                    json={"user_id": user_id, "key": setting["key"], "value": setting["value"]}
                )
            except httpx.HTTPError as e:
                logger.error("external_sync_failed", error=str(e), user_id=user_id)

        return {
            "user_id": user.id,
            "username": user.username,
            "email": user.email,
            "settings": updated,
            "total_settings": len(updated)
        }


@app.get("/api/user/{user_id}/settings")
async def get_user_settings(
        user_id: int,
        db: AsyncSession = Depends(get_db)
):
    """Get user settings"""
    service = SettingsService(db)
    result = await service.get_settings(user_id)
    return result


@app.post("/api/user/{user_id}/settings")
async def update_user_settings(
        user_id: int,
        body: SettingsUpdate,
        db: AsyncSession = Depends(get_db)
):
    """Update user settings and sync with external preferences service"""
    service = SettingsService(db)
    return await service.update_settings(user_id, body.settings)
