import logging
from logging.handlers import RotatingFileHandler

from madnolia.constants import (
    VIEWER_LOG_BACKUP_COUNT,
    VIEWER_LOG_MAX_BYTES,
    VIEWER_LOG_PATH,
)


def configure_viewer_logging() -> None:
    logger = logging.getLogger("uvicorn.error")
    target = VIEWER_LOG_PATH.resolve()
    if any(
        isinstance(handler, RotatingFileHandler)
        and getattr(handler, "baseFilename", None) == str(target)
        for handler in logger.handlers
    ):
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(
        target,
        maxBytes=VIEWER_LOG_MAX_BYTES,
        backupCount=VIEWER_LOG_BACKUP_COUNT,
        encoding="utf-8",
    )
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(handler)


def log_event(scope: str, message: str, *args: object) -> None:
    logging.getLogger("uvicorn.error").info(f"[{scope}] {message}", *args)
