import os
import json
import asyncio
from datetime import datetime, date, timedelta
from typing import Optional

from fastapi import FastAPI, Depends, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import declarative_base, sessionmaker
from sqlalchemy import Column, String, Text, DateTime, select
from jose import jwt, JWTError
import httpx
from pywebpush import webpush, WebPushException
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from pydantic import BaseModel

# ── Config ──────────────────────────────────────
GOOGLE_CLIENT_ID = os.environ["GOOGLE_CLIENT_ID"]
JWT_SECRET       = os.environ["JWT_SECRET"]
JWT_ALGORITHM    = "HS256"
JWT_EXPIRE_DAYS  = 30
VAPID_PUBLIC_KEY = os.environ["VAPID_PUBLIC_KEY"]
VAPID_EMAIL      = os.environ["VAPID_EMAIL"]
ALLOWED_ORIGINS  = os.environ.get("ALLOWED_ORIGINS", "").split(",")
NOTIFY_HOUR      = int(os.environ.get("NOTIFY_HOUR", "8"))
DB_PATH          = os.environ.get("DB_PATH", "/home/ubuntu/pantry/pantry.db")

_vapid_key_path  = os.environ.get("VAPID_PRIVATE_KEY_PATH", "/home/ubuntu/pantry/vapid_private.pem")
with open(_vapid_key_path, "rb") as _f:
    VAPID_PRIVATE_KEY = _f.read().decode()

# ── Database ─────────────────────────────────────
engine            = create_async_engine(f"sqlite+aiosqlite:///{DB_PATH}", echo=False)
Base              = declarative_base()
AsyncSessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

class UserModel(Base):
    __tablename__ = "users"
    id         = Column(String, primary_key=True)  # Google sub
    email      = Column(String, unique=True)
    name       = Column(String)
    created_at = Column(DateTime, default=datetime.utcnow)

class PantryModel(Base):
    __tablename__ = "pantry"
    user_id    = Column(String, primary_key=True)
    # Encrypted blob — server never sees plaintext
    data       = Column(Text, default="")
    # Encrypted notification summary — computed by app, still opaque to server
    # Format after decryption (done client-side before sending):
    # [{"title": "Oat milk", "body": "Expires tomorrow"}, ...]
    # But we store and send it encrypted so server can't read it either
    notif_data = Column(Text, default="")
    updated_at = Column(DateTime, default=datetime.utcnow)

class PushSubModel(Base):
    __tablename__ = "push_subscriptions"
    id           = Column(String, primary_key=True)  # endpoint URL
    user_id      = Column(String)
    subscription = Column(Text)
    created_at   = Column(DateTime, default=datetime.utcnow)

async def get_db():
    async with AsyncSessionLocal() as session:
        yield session

async def init_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

# ── Pydantic models ───────────────────────────────
class GoogleTokenRequest(BaseModel):
    id_token: str

class PantryPayload(BaseModel):
    # Both fields are encrypted base64 strings — server treats them as opaque
    data:       str   # encrypted full pantry
    notif_data: str   # encrypted notification summary

class PushSubscription(BaseModel):
    subscription: dict

# ── App ───────────────────────────────────────────
app = FastAPI(title="Pantry Server")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Auth helpers ──────────────────────────────────
async def verify_google_token(id_token: str) -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.get(
            "https://oauth2.googleapis.com/tokeninfo",
            params={"id_token": id_token}
        )
    if r.status_code != 200:
        raise HTTPException(status_code=401, detail="Invalid Google token")
    payload = r.json()
    if payload.get("aud") != GOOGLE_CLIENT_ID:
        raise HTTPException(status_code=401, detail="Token audience mismatch")
    return payload

def make_jwt(user_id: str, email: str) -> str:
    expire = datetime.utcnow() + timedelta(days=JWT_EXPIRE_DAYS)
    return jwt.encode(
        {"sub": user_id, "email": email, "exp": expire},
        JWT_SECRET, algorithm=JWT_ALGORITHM
    )

async def get_current_user(request: Request, db: AsyncSession = Depends(get_db)) -> UserModel:
    token = request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload  = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        user_id  = payload["sub"]
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")
    result = await db.execute(select(UserModel).where(UserModel.id == user_id))
    user   = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user

# ── Routes ────────────────────────────────────────
@app.on_event("startup")
async def startup():
    await init_db()
    scheduler.start()

@app.get("/health")
async def health():
    return {"status": "ok"}

# ── Auth ──
@app.post("/auth/google")
async def auth_google(body: GoogleTokenRequest, db: AsyncSession = Depends(get_db)):
    payload = await verify_google_token(body.id_token)
    user_id = payload["sub"]
    email   = payload.get("email", "")
    name    = payload.get("name", "")

    result = await db.execute(select(UserModel).where(UserModel.id == user_id))
    user   = result.scalar_one_or_none()
    if not user:
        user = UserModel(id=user_id, email=email, name=name)
        db.add(user)
        db.add(PantryModel(user_id=user_id, data="", notif_data=""))
    else:
        user.name  = name
        user.email = email
    await db.commit()

    return {"token": make_jwt(user_id, email), "name": name, "email": email}

# ── Pantry ──
@app.get("/pantry")
async def get_pantry(
    user: UserModel      = Depends(get_current_user),
    db:   AsyncSession   = Depends(get_db)
):
    result = await db.execute(select(PantryModel).where(PantryModel.user_id == user.id))
    pantry = result.scalar_one_or_none()
    if not pantry:
        return {"data": "", "updated_at": None}
    return {
        "data":       pantry.data,
        "updated_at": pantry.updated_at.isoformat() if pantry.updated_at else None
    }

@app.put("/pantry")
async def save_pantry(
    body: PantryPayload,
    user: UserModel    = Depends(get_current_user),
    db:   AsyncSession = Depends(get_db)
):
    result = await db.execute(select(PantryModel).where(PantryModel.user_id == user.id))
    pantry = result.scalar_one_or_none()
    if pantry:
        pantry.data       = body.data
        pantry.notif_data = body.notif_data
        pantry.updated_at = datetime.utcnow()
    else:
        db.add(PantryModel(
            user_id    = user.id,
            data       = body.data,
            notif_data = body.notif_data
        ))
    await db.commit()
    return {"ok": True}

# ── Push subscriptions ──
@app.post("/push/subscribe")
async def subscribe(
    body: PushSubscription,
    user: UserModel      = Depends(get_current_user),
    db:   AsyncSession   = Depends(get_db)
):
    endpoint = body.subscription.get("endpoint", "")
    if not endpoint:
        raise HTTPException(status_code=400, detail="Missing endpoint")
    result = await db.execute(select(PushSubModel).where(PushSubModel.id == endpoint))
    sub    = result.scalar_one_or_none()
    if sub:
        sub.subscription = json.dumps(body.subscription)
        sub.user_id      = user.id
    else:
        db.add(PushSubModel(
            id=endpoint, user_id=user.id,
            subscription=json.dumps(body.subscription)
        ))
    await db.commit()
    return {"ok": True}

@app.delete("/push/subscribe")
async def unsubscribe(
    body: PushSubscription,
    user: UserModel      = Depends(get_current_user),
    db:   AsyncSession   = Depends(get_db)
):
    endpoint = body.subscription.get("endpoint", "")
    result   = await db.execute(select(PushSubModel).where(PushSubModel.id == endpoint))
    sub      = result.scalar_one_or_none()
    if sub and sub.user_id == user.id:
        await db.delete(sub)
        await db.commit()
    return {"ok": True}

@app.get("/push/vapid-public-key")
async def get_vapid_public_key():
    return {"key": VAPID_PUBLIC_KEY}

# ── Daily notifications ────────────────────────────
# The server sends the encrypted notif_data blob as the push payload.
# The service worker on the device decrypts it and builds the notification.
# The server never sees plaintext — it just ferries the encrypted blob.
def send_push(subscription_json: str, payload: dict) -> bool:
    try:
        sub = json.loads(subscription_json)
        webpush(
            subscription_info  = sub,
            data               = json.dumps(payload),
            vapid_private_key  = VAPID_PRIVATE_KEY,
            vapid_claims       = {"sub": VAPID_EMAIL},
        )
        return True
    except WebPushException as e:
        print(f"[Push] Failed: {e}")
        return False

async def send_daily_notifications():
    print(f"[Scheduler] Daily notification run at {datetime.now()}")
    async with AsyncSessionLocal() as db:
        result   = await db.execute(select(PantryModel))
        pantries = result.scalars().all()
        for pantry in pantries:
            # Skip users with no notification data or no subscriptions
            if not pantry.notif_data:
                continue
            subs_result = await db.execute(
                select(PushSubModel).where(PushSubModel.user_id == pantry.user_id)
            )
            subs = subs_result.scalars().all()
            if not subs:
                continue
            # Send the encrypted blob — device decrypts and displays it
            payload = {"encrypted": pantry.notif_data}
            dead    = []
            for sub in subs:
                ok = send_push(sub.subscription, payload)
                if not ok:
                    dead.append(sub)
            # Remove dead subscriptions
            for sub in dead:
                await db.delete(sub)
            if dead:
                await db.commit()

# ── Scheduler ─────────────────────────────────────
scheduler = AsyncIOScheduler(timezone="Europe/London")
scheduler.add_job(
    send_daily_notifications,
    trigger = "cron",
    hour    = NOTIFY_HOUR,
    minute  = 0,
)
