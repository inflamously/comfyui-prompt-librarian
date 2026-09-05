"""The one place the dictionary touches the network: a small, capped HTTP GET."""

import urllib.error
import urllib.request
from collections.abc import Callable

#: ``get(url) -> (status, body)``; raises :class:`ServiceUnavailableError` when offline.
HttpGet = Callable[[str], tuple[int, bytes]]

USER_AGENT = "comfyui-prompt-library/0.1 (dictionary)"
TIMEOUT_SECONDS = 30
#: The WordNet archive is about 11 MB; anything far larger is not it.
MAX_BYTES = 32 * 1024 * 1024


class ServiceUnavailableError(OSError):
    """The download could not be reached or was refused; try again later."""


def http_get(url: str) -> tuple[int, bytes]:
    """GET ``url`` and return ``(status, body)``.

    Raises:
        ServiceUnavailableError: No connection, a timeout, or an HTTP error.
    """
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:  # noqa: S310 - fixed https host
            return response.status, response.read(MAX_BYTES)
    except urllib.error.HTTPError as exc:
        raise ServiceUnavailableError(f"{exc.code} from {url}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ServiceUnavailableError(str(exc)) from exc
