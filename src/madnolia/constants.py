from pathlib import Path

DEFAULT_INPUT_DIR = Path("data/input/videos")
DEFAULT_OUTPUT_DIR = Path("data/output")
DEFAULT_VIEWER_HOST = "127.0.0.1"
DEFAULT_VIEWER_PORT = 8000
NLTK_DATA_DIR = Path("data/cache/nltk")
DEFAULT_MODEL_NAME = "small"
DEFAULT_INFERENCE_DEVICE = "CPU"
OPENVINO_AUDIO_CHUNK_SECONDS = 30
VAD_MERGE_GAP_MS = 400
VAD_MIN_SILENCE_DURATION_MS = 500
VAD_MIN_SPEECH_DURATION_MS = 250
VAD_SPEECH_PAD_MS = 200
VAD_THRESHOLD = 0.5
VIEWER_MAX_WAVEFORM_BINS = 4000
VIEWER_MIN_WAVEFORM_BINS = 100
OPENVINO_MODEL_REPOSITORIES = {
    "small": "OpenVINO/whisper-small-int8-ov",
}
MODEL_CACHE_DIR = Path("data/cache/models")
SUPPORTED_VIDEO_EXTENSIONS = frozenset(
    {".mp4", ".mkv", ".mov", ".avi", ".webm", ".m4v", ".mts", ".m2ts"}
)
SCHEMA_VERSION = "0.1.0"

HANGUL_BASE = 0xAC00
HANGUL_END = 0xD7A3
INITIAL_COUNT = 19
MEDIAL_COUNT = 21
FINAL_COUNT = 28

INITIALS = (
    "ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ", "ㅅ",
    "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ",
)
MEDIALS = (
    "ㅏ", "ㅐ", "ㅑ", "ㅒ", "ㅓ", "ㅔ", "ㅕ", "ㅖ", "ㅗ", "ㅘ", "ㅙ",
    "ㅚ", "ㅛ", "ㅜ", "ㅝ", "ㅞ", "ㅟ", "ㅠ", "ㅡ", "ㅢ", "ㅣ",
)
FINALS = (
    "", "ㄱ", "ㄲ", "ㄳ", "ㄴ", "ㄵ", "ㄶ", "ㄷ", "ㄹ", "ㄺ", "ㄻ", "ㄼ",
    "ㄽ", "ㄾ", "ㄿ", "ㅀ", "ㅁ", "ㅂ", "ㅄ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅊ",
    "ㅋ", "ㅌ", "ㅍ", "ㅎ",
)

INITIAL_IPA = {
    "ㄱ": ("ko.consonant.velar.plosive.lenis", "k"),
    "ㄲ": ("ko.consonant.velar.plosive.fortis", "k͈"),
    "ㄴ": ("ko.consonant.alveolar.nasal", "n"),
    "ㄷ": ("ko.consonant.alveolar.plosive.lenis", "t"),
    "ㄸ": ("ko.consonant.alveolar.plosive.fortis", "t͈"),
    "ㄹ": ("ko.consonant.alveolar.tap", "ɾ"),
    "ㅁ": ("ko.consonant.bilabial.nasal", "m"),
    "ㅂ": ("ko.consonant.bilabial.plosive.lenis", "p"),
    "ㅃ": ("ko.consonant.bilabial.plosive.fortis", "p͈"),
    "ㅅ": ("ko.consonant.alveolar.fricative.lenis", "s"),
    "ㅆ": ("ko.consonant.alveolar.fricative.fortis", "s͈"),
    "ㅈ": ("ko.consonant.alveolopalatal.affricate.lenis", "tɕ"),
    "ㅉ": ("ko.consonant.alveolopalatal.affricate.fortis", "tɕ͈"),
    "ㅊ": ("ko.consonant.alveolopalatal.affricate.aspirated", "tɕʰ"),
    "ㅋ": ("ko.consonant.velar.plosive.aspirated", "kʰ"),
    "ㅌ": ("ko.consonant.alveolar.plosive.aspirated", "tʰ"),
    "ㅍ": ("ko.consonant.bilabial.plosive.aspirated", "pʰ"),
    "ㅎ": ("ko.consonant.glottal.fricative", "h"),
}
MEDIAL_IPA = {
    "ㅏ": ("ko.vowel.a", "a"), "ㅐ": ("ko.vowel.ae", "ɛ"),
    "ㅑ": ("ko.vowel.ya", "ja"), "ㅒ": ("ko.vowel.yae", "jɛ"),
    "ㅓ": ("ko.vowel.eo", "ʌ"), "ㅔ": ("ko.vowel.e", "e"),
    "ㅕ": ("ko.vowel.yeo", "jʌ"), "ㅖ": ("ko.vowel.ye", "je"),
    "ㅗ": ("ko.vowel.o", "o"), "ㅘ": ("ko.vowel.wa", "wa"),
    "ㅙ": ("ko.vowel.wae", "wɛ"), "ㅚ": ("ko.vowel.oe", "we"),
    "ㅛ": ("ko.vowel.yo", "jo"), "ㅜ": ("ko.vowel.u", "u"),
    "ㅝ": ("ko.vowel.wo", "wʌ"), "ㅞ": ("ko.vowel.we", "we"),
    "ㅟ": ("ko.vowel.wi", "wi"), "ㅠ": ("ko.vowel.yu", "ju"),
    "ㅡ": ("ko.vowel.eu", "ɯ"), "ㅢ": ("ko.vowel.ui", "ɰi"),
    "ㅣ": ("ko.vowel.i", "i"),
}
FINAL_IPA = {
    "ㄱ": ("ko.coda.velar", "k̚"), "ㄲ": ("ko.coda.velar", "k̚"),
    "ㄳ": ("ko.coda.velar", "k̚"), "ㄴ": ("ko.coda.alveolar.nasal", "n"),
    "ㄵ": ("ko.coda.alveolar.nasal", "n"), "ㄶ": ("ko.coda.alveolar.nasal", "n"),
    "ㄷ": ("ko.coda.alveolar", "t̚"), "ㄹ": ("ko.coda.alveolar.lateral", "l"),
    "ㄺ": ("ko.coda.velar", "k̚"), "ㄻ": ("ko.coda.bilabial.nasal", "m"),
    "ㄼ": ("ko.coda.alveolar.lateral", "l"), "ㄽ": ("ko.coda.alveolar.lateral", "l"),
    "ㄾ": ("ko.coda.alveolar.lateral", "l"), "ㄿ": ("ko.coda.bilabial", "p̚"),
    "ㅀ": ("ko.coda.alveolar.lateral", "l"), "ㅁ": ("ko.coda.bilabial.nasal", "m"),
    "ㅂ": ("ko.coda.bilabial", "p̚"), "ㅄ": ("ko.coda.bilabial", "p̚"),
    "ㅅ": ("ko.coda.alveolar", "t̚"), "ㅆ": ("ko.coda.alveolar", "t̚"),
    "ㅇ": ("ko.coda.velar.nasal", "ŋ"), "ㅈ": ("ko.coda.alveolar", "t̚"),
    "ㅊ": ("ko.coda.alveolar", "t̚"), "ㅋ": ("ko.coda.velar", "k̚"),
    "ㅌ": ("ko.coda.alveolar", "t̚"), "ㅍ": ("ko.coda.bilabial", "p̚"),
    "ㅎ": ("ko.coda.alveolar", "t̚"),
}
VOWEL_PHONE_PREFIX = "ko.vowel."
