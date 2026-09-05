"""A tiny synthetic WordNet archive in the real file format."""

import io
import zipfile

HEADER = "  1 This is a synthetic fixture, not the WordNet database.  \n"

FILES = {
    "data.adj": HEADER + (
        '00000001 00 a 01 dark 0 001 ! 00000002 a 0101 | devoid of light; "a dark room"  \n'
        '00000002 00 a 01 light 0 001 ! 00000001 a 0101 | having abundant light; "a light room"  \n'
        '00000003 00 s 02 misty 0 foggy(a) 0 001 & 00000001 a 0000 | filled with mist; '
        '"a misty morning"; "misty hills"  \n'
    ),
    "index.adj": (
        "dark a 1 1 ! 1 0 00000001  \n"
        "light a 1 1 ! 1 0 00000002  \n"
        "misty a 1 1 & 1 0 00000003  \n"
        "foggy a 1 1 & 1 0 00000003  \n"
    ),
    "data.noun": HEADER + (
        "00000010 00 n 02 forest 0 wood 0 000 | land covered with trees  \n"
        '00000011 00 n 01 goose 0 000 | a web-footed bird; "geese flew over"  \n'
        "00000012 00 n 01 hour 0 000 | a period of sixty minutes  \n"
        "00000013 00 n 01 light 0 000 | electromagnetic radiation you can see  \n"
    ),
    "index.noun": (
        "forest n 1 0 1 0 00000010  \n"
        "goose n 1 0 1 0 00000011  \n"
        "hour n 1 0 1 0 00000012  \n"
        "light n 1 0 1 0 00000013  \n"
        "wood n 1 0 1 0 00000010  \n"
    ),
    "noun.exc": "geese goose\n",
    "data.verb": HEADER,
    "data.adv": HEADER,
}


def archive(files: dict[str, str] = FILES) -> bytes:
    """The fixture as the zip bytes a download would return."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        for name, text in files.items():
            zf.writestr(f"wordnet/{name}", text)
    return buffer.getvalue()


class FakeGet:
    """Stands in for ``http_get``; records the URLs it was asked for."""

    def __init__(self, body: bytes | None = None, error: Exception | None = None) -> None:
        self.body = archive() if body is None else body
        self.error = error
        self.urls: list[str] = []

    def __call__(self, url: str) -> tuple[int, bytes]:
        self.urls.append(url)
        if self.error:
            raise self.error
        return 200, self.body
