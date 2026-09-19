from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator


class Viewport(BaseModel):
    w: int = Field(ge=1, le=7680)
    h: int = Field(ge=1, le=4320)
    dpr: float = Field(ge=0.1, le=10.0, default=1.0)


class Candidate(BaseModel):
    id: str = Field(min_length=1, max_length=10)
    tag: str = Field(min_length=1, max_length=30)
    role: str = Field(default="", max_length=50)
    inputType: str | None = Field(default=None, max_length=30)
    label: str = Field(default="", max_length=200)
    masked_text: str = Field(default="", max_length=120)
    bbox: list[float] = Field(min_length=4, max_length=4)
    editable: bool = False

    model_config = {"extra": "forbid"}

    @field_validator("bbox")
    @classmethod
    def validate_bbox(cls, v: list[float]) -> list[float]:
        if len(v) != 4:
            raise ValueError("bbox must have exactly 4 elements [x, y, w, h]")
        x, y, w, h = v
        if w < 0 or h < 0:
            raise ValueError(f"bbox width and height must be non-negative, got w={w} h={h}")
        if x < -10000 or x > 10000 or y < -10000 or y > 10000:
            raise ValueError(f"bbox coordinates out of sane range: x={x} y={y}")
        if w > 10000 or h > 10000:
            raise ValueError(f"bbox dimensions out of sane range: w={w} h={h}")
        return v

    @field_validator("id")
    @classmethod
    def validate_id(cls, v: str) -> str:
        if not v.startswith("n") or not v[1:].isdigit():
            raise ValueError(f"candidate id must be 'n<number>', got '{v}'")
        return v


class HistoryItem(BaseModel):
    action: str = Field(min_length=1, max_length=20)
    target_id: str | None = Field(default=None, max_length=10)
    value: str | None = Field(default=None, max_length=200)

    model_config = {"extra": "forbid"}


class SanitizedPayload(BaseModel):
    session_id: str = Field(min_length=1, max_length=50)
    step: int = Field(ge=0, le=1000)
    user_goal: str = Field(min_length=1, max_length=500)
    screenshot: str = Field(default="", max_length=15_000_000)
    use_image: bool = True
    viewport: Viewport
    candidates: list[Candidate] = Field(min_length=0, max_length=60)
    history: list[HistoryItem] = Field(default_factory=list, max_length=100)
    client_meta: dict[str, Any] = Field(default_factory=dict)

    model_config = {"extra": "forbid"}

    @field_validator("screenshot")
    @classmethod
    def validate_screenshot(cls, v: str) -> str:
        if v and not v.startswith("data:image/"):
            raise ValueError("screenshot must be a data:image/ URL or empty string")
        return v


class ActionResponse(BaseModel):
    action: Literal["click", "type", "scroll", "wait", "done", "ask_user"]
    target_id: str | None = None
    value: str | None = Field(default=None, max_length=200)
    confidence: float = Field(ge=0.0, le=1.0)
    reasoning: str = Field(max_length=1000)
    server_meta: dict[str, Any] = {}


class ErrorDetail(BaseModel):
    code: str
    message: str
    retry_attempted: bool = False


class ErrorResponse(BaseModel):
    error: ErrorDetail


VALID_ACTIONS = ("click", "type", "scroll", "wait", "done", "ask_user")
