"""Synthetic showcase data for :mod:`scripts.devserver`.

The first fifty records are deliberately hand-written.  They make the
playground useful for design work instead of filling it with shuffled keywords,
while still exercising ratings, tags, notes, pinning, usage, history, wildcard
syntax, snippets, and duplicate handling.  Nothing here is copied from a user
library.
"""

from dataclasses import dataclass

DEFAULT_PROMPT_COUNT = 50


@dataclass(frozen=True, slots=True)
class PromptSeed:
    key: str
    body: str
    tags: tuple[str, ...]
    rating: int = 0
    used: int = 0
    notes: str = ""
    pinned: bool = False
    history: tuple[str, ...] = ()
    deep_history: bool = False
    ignore_with: str = ""


SHOWCASE_PROMPTS = (
    PromptSeed(
        "neon-cyclist",
        "A bicycle courier crossing a rain-soaked Tokyo alley at midnight, neon signs "
        "reflected in every puddle, low tracking angle, 35 mm film grain, cyan and magenta "
        "rim light, cinematic motion blur",
        ("cinematic", "street", "night", "photoreal", "people"),
        5,
        34,
        "Reliable hero image for checking long labels and saturated thumbnails.",
        True,
    ),
    PromptSeed(
        "glacier-observatory",
        "A tiny astronomical observatory on the edge of a blue glacier, aurora sweeping above "
        "the dome, lone warm window, immense quiet landscape, crisp stars, panoramic composition",
        ("landscape", "night", "architecture", "cinematic"),
        5,
        18,
    ),
    PromptSeed(
        "brutalist-library",
        "Brutalist public library atrium, monumental board-formed concrete, a single red spiral "
        "staircase, tiny readers for scale, overcast skylight, precise architectural photography",
        ("architecture", "interior", "photoreal", "editorial"),
        4,
        11,
    ),
    PromptSeed(
        "midnight-ramen",
        "Close-up food photograph of miso ramen in a small midnight diner, glossy broth, handmade "
        "noodles, soft egg and scallions, steam catching the tungsten light, shallow depth "
        "of field",
        ("food", "photoreal", "close-up", "night"),
        4,
        22,
    ),
    PromptSeed(
        "orchard-bee",
        "Extreme macro photograph of a honeybee dusted with yellow pollen on an apple blossom, "
        "translucent wings, dew beads, creamy spring bokeh, natural morning light",
        ("macro", "wildlife", "photoreal", "spring"),
        5,
        27,
    ),
    PromptSeed(
        "cobalt-fashion",
        "Avant-garde fashion editorial, model in a sculptural cobalt gown on wind-carved white "
        "dunes, fabric billowing like a sail, hard noon sun, clean negative space, medium format",
        ("fashion", "editorial", "portrait", "desert"),
        4,
        9,
    ),
    PromptSeed(
        "anime-last-train",
        "Anime film still of two friends waiting for the last countryside train, summer rain "
        "beyond the platform roof, vending-machine glow, wet rails, tender quiet mood, "
        "hand-painted background",
        ("anime", "cinematic", "rain", "people"),
        5,
        31,
    ),
    PromptSeed(
        "moss-knight",
        "An ancient knight resting beneath a colossal cedar, armor overgrown with moss and tiny "
        "white flowers, shafts of dawn through mist, painterly dark fantasy concept art",
        ("fantasy", "character", "forest", "concept-art"),
        4,
        16,
    ),
    PromptSeed(
        "orbital-greenhouse",
        "Astronaut tending tomatoes inside a rotating orbital greenhouse, curved Earth filling the "
        "window, condensation on glass, practical white habitat, hopeful hard-science-fiction "
        "realism",
        ("sci-fi", "space", "photoreal", "solarpunk"),
        5,
        25,
        "Good search fixture for hyphenated and compound tags.",
        True,
    ),
    PromptSeed(
        "cedar-perfume",
        "Luxury perfume bottle on dark split cedar, one ribbon of smoke curling behind the glass, "
        "amber liquid, restrained black-and-gold palette, controlled studio highlights, "
        "product shot",
        ("product", "studio", "luxury", "photoreal"),
        4,
        13,
    ),
    PromptSeed(
        "winter-fox",
        "Red fox pausing in fresh snow at the edge of a birch forest, breath visible, soft "
        "flakes in "
        "the foreground, alert eyes, muted winter palette, intimate telephoto wildlife photograph",
        ("wildlife", "winter", "photoreal", "forest"),
        5,
        20,
    ),
    PromptSeed(
        "kelp-diver",
        "Freediver descending through a cathedral of giant kelp, sunbeams fractured by the "
        "surface, "
        "schools of silver fish, deep emerald water, graceful vertical composition",
        ("underwater", "people", "cinematic", "nature"),
        4,
        15,
    ),
    PromptSeed(
        "cloud-harbor",
        "A bustling harbor for wooden airships moored between mountaintop towers, porters crossing "
        "rope bridges above clouds, late-afternoon haze, richly detailed adventure illustration",
        ("fantasy", "environment", "illustration", "architecture"),
        3,
        7,
    ),
    PromptSeed(
        "potters-hands",
        "Documentary close-up of an elderly potter's hands centering clay on a wheel, slip on "
        "weathered "
        "fingers, quiet workshop, soft north-window light, honest texture, warm earthy color grade",
        ("documentary", "craft", "close-up", "people"),
        5,
        29,
    ),
    PromptSeed(
        "alpine-botanical",
        "Scientific botanical plate of alpine flowers, six specimens with roots and seed pods, "
        "delicate graphite outlines, restrained watercolor washes, ivory paper, neat "
        "handwritten labels",
        ("botanical", "watercolor", "illustration", "vintage"),
        4,
        8,
    ),
    PromptSeed(
        "venice-rain",
        "Loose watercolor of a quiet Venetian canal after rain, coral facades dissolving into wet "
        "reflections, one green boat, granulating pigment, visible cold-press paper texture",
        ("watercolor", "city", "rain", "traditional-media"),
        3,
        6,
    ),
    PromptSeed(
        "noir-elevator",
        "1940s film-noir still, private detective watching mirrored elevator doors in an empty "
        "hotel, "
        "venetian-blind shadows, cigarette haze, high-contrast black and white, tense composition",
        ("cinematic", "noir", "black-and-white", "interior"),
        4,
        12,
    ),
    PromptSeed(
        "reading-nook",
        "Cozy attic reading nook built around a round window, overflowing books, rumpled linen "
        "chair, "
        "sleeping orange cat, rain streaks on glass, warm lamps against a cool blue evening",
        ("interior", "cozy", "rain", "illustration"),
        5,
        40,
        "Frequently used fixture; useful when sorting by popularity.",
        True,
    ),
    PromptSeed(
        "forest-rally",
        "1970s rally car sliding through a wet pine-forest hairpin, gravel spraying toward camera, "
        "headlights in fog, spectators behind red tape, dynamic panning photograph",
        ("vehicle", "action", "forest", "vintage"),
        4,
        17,
    ),
    PromptSeed(
        "desert-courtyard",
        "Contemporary desert house wrapped around a shaded courtyard, rammed-earth walls, "
        "narrow lap "
        "pool, olive trees and woven chairs, quiet golden hour, architecture magazine photograph",
        ("architecture", "exterior", "desert", "editorial"),
        4,
        14,
    ),
    PromptSeed(
        "moon-garden",
        "Children's-book illustration of a young gardener planting glowing moon seeds with a "
        "gentle "
        "badger, midnight-blue garden, friendly shapes, gouache texture, whimsical hand lettering",
        ("children", "illustration", "gouache", "fantasy"),
        5,
        21,
    ),
    PromptSeed(
        "isometric-bakery",
        "Isometric cutaway of a tiny neighborhood bakery at 6 a.m., bakers shaping loaves "
        "upstairs, "
        "first customers below, warm ovens, meticulous props, soft pastel 3D render",
        ("isometric", "3d", "food", "interior"),
        4,
        10,
    ),
    PromptSeed(
        "pixel-shrine",
        "Detailed pixel-art forest shrine at dusk, stone foxes, red torii reflected in a stream, "
        "fireflies drifting between cedars, limited 32-color palette, 16-bit adventure-game scene",
        ("pixel-art", "forest", "fantasy", "game-art"),
        4,
        19,
    ),
    PromptSeed(
        "clay-robots",
        "Stop-motion scene of two thumb-sized clay robots repairing a cassette player, "
        "fingerprints visible in the models, improvised tools, cheerful desk-lamp lighting, "
        "playful miniature set",
        ("3d", "stop-motion", "miniature", "sci-fi"),
        2,
        5,
    ),
    PromptSeed(
        "paper-ocean",
        "Layered paper-cut ocean cross-section, lighthouse and storm waves above, whale and "
        "submarine "
        "below, crisp cut edges, deep navy through pale aqua layers, tactile shadow-box lighting",
        ("paper-art", "ocean", "illustration", "graphic"),
        4,
        9,
    ),
    PromptSeed(
        "embroidered-moth",
        "Luna moth embroidered with silk and metallic thread on midnight velvet, symmetrical "
        "museum "
        "display, tiny bead constellations around the wings, richly tactile fiber-art photograph",
        ("textile", "macro", "craft", "nature"),
        4,
        4,
    ),
    PromptSeed(
        "ink-samurai",
        "Lone samurai crossing a windswept ridge, expressive sumi-e ink wash, cloak reduced to "
        "three "
        "bold brush strokes, distant mountain in pale gray, generous white paper, red seal",
        ("ink", "character", "traditional-media", "minimalist"),
        5,
        23,
    ),
    PromptSeed(
        "art-nouveau-bicycle",
        "Art Nouveau travel poster advertising a coastal bicycle route, elegant rider framed by "
        "poppies and curling sea foam, flat teal and vermilion inks, ornate 1905 typography",
        ("poster", "art-nouveau", "vintage", "graphic-design"),
        4,
        8,
    ),
    PromptSeed(
        "jazz-poster",
        "Swiss International Style poster for an experimental jazz festival, oversized lowercase "
        "type on a strict grid, one electric-orange circle, black and cream, crisp screenprint "
        "texture",
        ("poster", "typography", "graphic-design", "modernist"),
        4,
        6,
        history=(
            "Swiss-style jazz poster, black type on cream paper, strict asymmetric grid",
            "Modernist jazz-festival poster, oversized type, orange circle, black and cream",
        ),
    ),
    PromptSeed(
        "tidal-album",
        "Abstract album cover: concentric topographic lines bending around a black sun, "
        "oxidized copper "
        "and sea-green ink, subtle misregistration, square composition, no readable text",
        ("album-art", "abstract", "graphic-design", "print"),
        1,
        5,
    ),
    PromptSeed(
        "zen-stones",
        "Minimal still life of three river stones and a single reed on warm handmade paper, "
        "diffuse morning shadow, wabi-sabi restraint, quiet asymmetrical composition, natural "
        "fibers visible",
        ("minimalist", "still-life", "studio", "calm"),
        4,
        12,
    ),
    PromptSeed(
        "double-exposure-dancer",
        "Double-exposure portrait of a contemporary dancer, translucent gesture layered with a "
        "flock of starlings, charcoal-gray background, controlled studio silhouette, elegant "
        "negative space",
        ("portrait", "dance", "experimental", "studio"),
        4,
        15,
    ),
    PromptSeed(
        "desert-whale",
        "A vast blue whale swimming slowly above wind-rippled desert dunes, tiny caravan below for "
        "scale, clear pale sky, believable afternoon light, serene surrealism, wide cinematic "
        "frame",
        ("surreal", "desert", "cinematic", "concept-art"),
        5,
        26,
    ),
    PromptSeed(
        "solarpunk-canal",
        "Solarpunk canal district grown around old brick warehouses, balconies overflowing with "
        "food gardens, quiet electric ferries, neighbors on shaded walkways, bright humane "
        "future, midday",
        ("solarpunk", "city", "environment", "concept-art"),
        5,
        28,
    ),
    PromptSeed(
        "bog-witch",
        "Dark-fantasy portrait of a bog witch carrying a lantern made from amber resin, reed "
        "crown, moth-eaten cloak, peat fog and ghost lights, Rembrandt lighting, intricate "
        "painterly detail",
        ("fantasy", "portrait", "dark", "character"),
        4,
        17,
    ),
    PromptSeed(
        "lunar-diner",
        "Retrofuturist roadside diner on the Moon, chrome booths visible through a curved window, "
        "parked rover under a buzzing pink sign, Earth low on the horizon, 1960s magazine "
        "illustration",
        ("retrofuturism", "sci-fi", "architecture", "illustration"),
        4,
        13,
    ),
    PromptSeed(
        "harbor-fisherman",
        "Environmental portrait of a fisherman mending green nets before sunrise, weathered harbor "
        "wall, gulls and trawlers softly out of focus, available light, respectful documentary "
        "style",
        ("documentary", "portrait", "harbor", "people"),
        5,
        24,
    ),
    PromptSeed(
        "window-portrait",
        "Quiet black-and-white portrait beside a tall apartment window, soft side light, direct "
        "gaze, "
        "subtle skin texture, plain dark sweater, medium-format tonal range, no retouching",
        ("portrait", "black-and-white", "photoreal", "editorial"),
        4,
        10,
    ),
    PromptSeed(
        "infrared-marsh",
        "Infrared photograph of a winding river through summer marshland, white foliage against an "
        "ink-black sky, distant storm, luminous water, fine-art aerial composition",
        ("landscape", "infrared", "experimental", "nature"),
        2,
        3,
    ),
    PromptSeed(
        "tilt-shift-crossing",
        "Tilt-shift view of a crowded city crossing from a rooftop, umbrellas forming bright color "
        "clusters, miniature effect, narrow plane of focus, orderly geometry amid movement",
        ("city", "aerial", "photoreal", "people"),
        3,
        7,
    ),
    PromptSeed(
        "summer-picnic",
        "Overhead editorial photograph of a summer picnic on a red checked blanket: peaches, "
        "sourdough, "
        "soft cheese, wildflowers and enamel cups, dappled tree shade, casual lived-in arrangement",
        ("food", "still-life", "editorial", "summer"),
        4,
        16,
    ),
    PromptSeed(
        "kinetic-sneaker",
        "High-energy sneaker campaign, white running shoe suspended above electric-blue powder "
        "bursting "
        "outward, razor-sharp product detail, frozen motion, bold studio gradient, space for copy",
        ("product", "advertising", "studio", "action"),
        4,
        14,
    ),
    PromptSeed(
        "opal-ring",
        "Macro jewelry photograph of an antique opal ring balanced on weathered slate, prismatic "
        "fire "
        "inside the stone, soft black flags reflected in silver, precise luxury lighting",
        ("product", "macro", "luxury", "studio"),
        4,
        9,
    ),
    PromptSeed(
        "heart-diagram",
        "Subject: human heart in a clean anatomical cutaway\n"
        "View: chambers and major vessels clearly separated, no labels\n"
        "Style: muted red and blue medical illustration, fine stipple shading, white background",
        ("scientific", "diagram", "illustration", "anatomy"),
        0,
        2,
    ),
    PromptSeed(
        "portrait-wildcard",
        "Editorial portrait of a subject with __hair__ hair, expression: __mood__, wearing "
        "{a tailored linen suit|an oversized knit sweater|a translucent raincoat}; "
        "{soft window light|hard flash|late golden-hour backlight}, 85 mm lens",
        ("portrait", "wildcard", "editorial", "people"),
        4,
        18,
        "Exercises file wildcards and nested inline choices in the preview tool.",
        True,
    ),
    PromptSeed(
        "cinematic-snippet",
        "[[quality]], solitary botanist entering a glasshouse reclaimed by jungle, "
        "{dawn mist|summer thunderstorm|moonlit fog}, wet leaves in the foreground, "
        "[[cinematic-light]], natural color separation",
        ("cinematic", "wildcard", "environment", "photoreal"),
        5,
        20,
        "Exercises snippets and inline choices together.",
    ),
    PromptSeed(
        "color-script",
        "Color-script frame: a small orange rescue boat entering an immense violet storm, pale "
        "break in the clouds directly ahead, simplified shapes, readable value structure, "
        "hopeful final beat",
        ("concept-art", "color-script", "ocean", "cinematic"),
        5,
        30,
        "Carries a deliberately deep history for the versions browser.",
        True,
        (
            "Color-script thumbnail: rescue boat beneath a dark storm, simple value blocks",
            "Color-script study: orange rescue boat, indigo sea, a narrow light on the horizon",
            "Color-script frame: tiny orange rescue boat crossing violet waves toward a pale "
            "horizon",
        ),
        True,
    ),
    PromptSeed(
        "tea-still-life",
        "Still life of a handmade tea bowl, folded linen and one quince branch on a dark oak "
        "table, "
        "north-window light, muted earth tones, quiet Dutch-painting composition",
        ("still-life", "ceramic", "calm", "photoreal"),
        4,
        7,
        "Intentionally muted duplicate pair for testing “keep both”.",
        False,
        (),
        False,
        "tea-still-life-alt",
    ),
    PromptSeed(
        "tea-still-life-alt",
        "Still life of a handmade tea bowl, folded linen and one quince branch on a dark oak "
        "table, "
        "soft north-window light, muted earth tones, quiet Dutch-painting composition",
        ("still-life", "ceramic", "calm", "photoreal"),
        3,
        1,
        "Intentionally very close to the neighboring tea still life.",
    ),
    PromptSeed(
        "neon-cyclist-alt",
        "A bicycle courier crossing a rain-soaked Tokyo alley at midnight, neon signs reflected in "
        "every puddle, low tracking angle, 35 mm film grain, cyan and magenta rim light, cinematic "
        "motion blur, volumetric haze",
        ("cinematic", "street", "night", "photoreal", "people"),
        3,
        2,
        "Active near-duplicate of the pinned neon courier prompt.",
    ),
)


SNIPPETS = {
    "quality": "high detail, intentional composition, clean focal hierarchy",
    "cinematic-light": "soft atmospheric depth, motivated practical light, subtle film grain",
    "negative-photo": "blurry, plastic skin, clipped highlights, watermark, duplicate subject",
    "negative-illustration": "muddy colors, broken anatomy, illegible text, noisy background",
}


WILDCARDS = {
    "hair": ("long silver", "short curly", "braided auburn", "close-cropped black"),
    "mood": ("calm", "defiant", "joyful", "contemplative", "quietly amused"),
    "weather": ("clear dawn", "summer rain", "rolling fog", "first snow", "distant storm"),
    "palette": ("cobalt and rust", "sage and cream", "violet and amber", "charcoal and coral"),
    "camera": ("24 mm wide angle", "50 mm normal lens", "85 mm portrait lens", "200 mm telephoto"),
    "material": ("brushed brass", "smoked glass", "handmade paper", "glazed ceramic", "raw linen"),
}


_EXTRA_SUBJECTS = (
    "an alpine rescue cabin",
    "a traveling puppet theatre",
    "a coastal weather station",
    "an electric motorcycle",
    "a community greenhouse",
    "a watchmaker at work",
    "a migrating crane",
    "a ceramic tea service",
    "a deep-sea research drone",
    "a midnight flower market",
    "a cliffside monastery",
    "a modular field radio",
)

_EXTRA_SETTINGS = (
    "on a foggy spring morning",
    "under crisp winter stars",
    "after a brief summer shower",
    "in warm late-afternoon light",
    "against a seamless studio backdrop",
    "beside a wind-ruffled lake",
    "inside a quiet converted warehouse",
    "among pale desert grasses",
    "beneath an approaching thunderhead",
    "at blue hour",
)

_EXTRA_STYLES = (
    "observational documentary photograph",
    "cinematic 35 mm film still",
    "detailed editorial illustration",
    "restrained gouache painting",
    "tactile stop-motion miniature",
    "clean product photograph",
    "atmospheric environment concept art",
    "bold screen-printed poster",
)

_EXTRA_DETAILS = (
    "layered depth and a clear focal point",
    "natural texture and believable wear",
    "strong silhouette and generous negative space",
    "subtle reflections and controlled highlights",
    "small human details that imply a story",
    "a limited harmonious color palette",
)


def generated_prompt(index):
    """Return a deterministic extra record for large ``--seed`` values."""
    subject_count = len(_EXTRA_SUBJECTS)
    setting_count = len(_EXTRA_SETTINGS)
    style_count = len(_EXTRA_STYLES)
    detail_count = len(_EXTRA_DETAILS)
    combinations = subject_count * setting_count * style_count * detail_count

    variant, slot = divmod(index, combinations)
    subject, slot = _pick(slot, _EXTRA_SUBJECTS)
    setting, slot = _pick(slot, _EXTRA_SETTINGS)
    style, slot = _pick(slot, _EXTRA_STYLES)
    detail, _slot = _pick(slot, _EXTRA_DETAILS)
    suffix = f", variation {variant + 2}" if variant else ""
    return PromptSeed(
        key=f"generated-{index + DEFAULT_PROMPT_COUNT + 1:04d}",
        body=f"{subject.capitalize()} {setting}, {style}, {detail}{suffix}",
        tags=("generated", _style_tag(style)),
        rating=(index * 5) % 6,
        used=(index * 7) % 8,
    )


def _pick(slot, values):
    return values[slot % len(values)], slot // len(values)


def _style_tag(style):
    if "photograph" in style:
        return "photoreal"
    if "illustration" in style:
        return "illustration"
    if "gouache" in style:
        return "gouache"
    if "stop-motion" in style:
        return "stop-motion"
    if "concept art" in style:
        return "concept-art"
    if "poster" in style:
        return "poster"
    return "cinematic"


def prompt_seeds(count):
    """Return exactly ``count`` synthetic prompt specifications."""
    count = max(0, int(count))
    curated = list(SHOWCASE_PROMPTS[:count])
    curated.extend(generated_prompt(i) for i in range(max(0, count - len(curated))))
    return curated


assert len(SHOWCASE_PROMPTS) == DEFAULT_PROMPT_COUNT
