"""Tolerant scalar coercion: malformed input becomes a default, never an exception."""

from typing import TypeVar

_N = TypeVar("_N", int, float)


def as_str(value: object, default: str = "") -> str:
    """``value`` as a string; ``None`` becomes ``default``."""
    if isinstance(value, str):
        return value
    if value is None:
        return default
    return str(value)


def as_int(value: object, default: int = 0) -> int:
    """``value`` as an int (floats and numeric strings truncate); else ``default``."""
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def clamp(value: _N, low: _N, high: _N) -> _N:
    """``value`` limited to ``low..high``."""
    return low if value < low else (high if value > high else value)
