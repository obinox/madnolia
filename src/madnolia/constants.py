from pathlib import Path

DEFAULT_INPUT_DIR = Path("data/input/videos")
DEFAULT_OUTPUT_DIR = Path("data/output")
DEFAULT_PROJECTS_DIR = Path("data/projects")
DEFAULT_COLLAGES_DIR = Path("data/collages")
DEFAULT_VIEWER_HOST = "127.0.0.1"
DEFAULT_VIEWER_PORT = 8000
OPENVINO_WORKER_ARGUMENT = "--openvino-worker"
HUGGINGFACE_CACHE_DIR = Path("data/cache/huggingface-hub")
TORCH_CACHE_DIR = Path("data/cache/torch")
GENERAL_CACHE_DIR = Path("data/cache")
NLTK_DATA_DIR = Path("data/cache/nltk")
DEFAULT_MODEL_NAME = "large-v3"
DEFAULT_ANALYSIS_BACKEND = "openvino"
DEFAULT_ANALYSIS_DEVICE = "GPU"
CUDA_DEVICE = "CUDA"
VULKAN_DEVICE = "VULKAN"
CPU_DEVICE = "CPU"
GPU_VENDOR_PRIORITY = (
    ("VEN_10DE", "NVIDIA", "faster-whisper", CUDA_DEVICE),
    ("VEN_1002", "AMD", "vulkan", VULKAN_DEVICE),
    ("VEN_8086", "Intel", "openvino", "GPU"),
)
BACKEND_DEFAULT_DEVICES = {
    "openvino": "GPU",
    "faster-whisper": CPU_DEVICE,
    "vulkan": VULKAN_DEVICE,
}
DEVICE_DEFAULT_BACKENDS = {
    "GPU": "openvino",
    CPU_DEVICE: "faster-whisper",
    CUDA_DEVICE: "faster-whisper",
    VULKAN_DEVICE: "vulkan",
}
WINDOWS_VIDEO_ADAPTER_COMMAND = (
    "Get-CimInstance Win32_VideoController | "
    "ForEach-Object { $_.PNPDeviceID }"
)
DEFAULT_ANALYSIS_ALIGNMENT = "ctc"
DEFAULT_ANALYSIS_ACOUSTIC_UNITS = True
ANALYSIS_NICKNAME_MAX_LENGTH = 80
ANALYSIS_MODEL_OPTIONS = ("large-v3", "large-v3-turbo", "small")
ANALYSIS_PROGRESS_MEDIA = 5
ANALYSIS_PROGRESS_AUDIO = 15
ANALYSIS_PROGRESS_TRANSCRIPTION_END = 85
ANALYSIS_PROGRESS_ALIGNMENT = 90
ANALYSIS_PROGRESS_FEATURES = 95
ANALYSIS_PROGRESS_STORAGE = 99
DEFAULT_INFERENCE_DEVICE = "CPU"
OPENVINO_AUDIO_CHUNK_SECONDS = 30
OPENVINO_AUDIO_OVERLAP_SECONDS = 5
OPENVINO_CONTEXT_WORDS = 24
OPENVINO_CONTEXT_MAX_GAP_MS = 10_000
TRANSCRIPTION_CHECKPOINT_DIR = Path("data/cache/transcription")
TRANSCRIPTION_CHECKPOINT_VERSION = 1
OPENVINO_WORKER_STARTUP_TIMEOUT_SECONDS = 120
OPENVINO_GPU_CHUNK_TIMEOUT_SECONDS = 120
OPENVINO_CPU_CHUNK_TIMEOUT_SECONDS = 240
OPENVINO_CHUNK_POLL_SECONDS = 0.5
OPENVINO_MIN_NEW_TOKENS = 32
OPENVINO_MAX_NEW_TOKENS = 300
OPENVINO_NEW_TOKENS_PER_SECOND = 10
OPENVINO_REPEATED_WORD_MIN_COUNT = 8
OPENVINO_REPEATED_WORD_RATIO = 0.75
VAD_MERGE_GAP_MS = 400
VAD_MIN_SILENCE_DURATION_MS = 500
VAD_MIN_SPEECH_DURATION_MS = 250
VAD_SPEECH_PAD_MS = 200
VAD_THRESHOLD = 0.5
VIEWER_MAX_WAVEFORM_BINS = 4000
VIEWER_MIN_WAVEFORM_BINS = 100
SEARCH_MAX_JOIN_GAP_MS = 500
SEARCH_MAX_CANDIDATES_PER_TARGET_START = 120
DEFAULT_CROSSFADE_MS = 8
MIN_STRETCH_PERCENT = 100
MAX_STRETCH_PERCENT = 150
STRETCH_FRAME_SAMPLES = 320
STRETCH_SEARCH_SAMPLES = 64
OPENVINO_MODEL_REPOSITORIES = {
    "large-v3": "OpenVINO/whisper-large-v3-int8-ov",
    "large-v3-turbo": "OpenVINO/whisper-large-v3-turbo-int8-ov",
    "small": "OpenVINO/whisper-small-int8-ov",
}
FASTER_WHISPER_MODEL_REPOSITORIES = {
    "tiny": "Systran/faster-whisper-tiny",
    "base": "Systran/faster-whisper-base",
    "large-v3": "Systran/faster-whisper-large-v3",
    "large-v3-turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
    "small": "Systran/faster-whisper-small",
    "medium": "Systran/faster-whisper-medium",
}
VULKAN_MODEL_REPOSITORY = "ggerganov/whisper.cpp"
VULKAN_MODEL_FILES = {
    "large-v3": "ggml-large-v3.bin",
    "large-v3-turbo": "ggml-large-v3-turbo.bin",
    "small": "ggml-small.bin",
}
MODEL_CACHE_DIR = Path("data/cache/models")
AUDIO_CACHE_DIR = Path("data/cache/audio")
AUDIO_CACHE_VERSION = "pcm_s16le_mono_16000_v1"
CTC_MODEL_REPOSITORY = "facebook/wav2vec2-xlsr-53-espeak-cv-ft"
HUBERT_MODEL_REPOSITORY = "facebook/hubert-base-ls960"
CTC_MODEL_DIR = MODEL_CACHE_DIR / "huggingface" / "wav2vec2-xlsr-53-espeak-cv-ft"
CTC_OPENVINO_MODEL_PATH = (
    MODEL_CACHE_DIR / "openvino" / "wav2vec2-xlsr-53-espeak-cv-ft" / "openvino_model.xml"
)
CTC_LOW_CONFIDENCE_THRESHOLD = 0.15
CTC_IPA_ALIASES = {"ɰi": ("ɯ", "i")}
HUBERT_OPENVINO_MODEL_PATH = MODEL_CACHE_DIR / "openvino" / "hubert-base-ls960" / "openvino_model.xml"
HUBERT_CLUSTER_COUNT = 64
HUBERT_CHUNK_MS = 15_000
HUBERT_CHUNK_GAP_MS = 1_000
SENTENCE_GAP_MS = 900
CTC_ALIGNMENT_CHUNK_MS = 15_000
CTC_ALIGNMENT_PADDING_MS = 250
ACOUSTIC_MODEL_INPUT_SAMPLES = 248_000
SUPPORTED_VIDEO_EXTENSIONS = frozenset(
    {".mp4", ".mkv", ".mov", ".avi", ".webm", ".m4v", ".mts", ".m2ts"}
)
SCHEMA_VERSION = "0.3.0"

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
