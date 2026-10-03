from pathlib import Path

DEFAULT_INPUT_DIR = Path("data/input/videos")
DEFAULT_OUTPUT_DIR = Path("data/output")
DEFAULT_PROJECTS_DIR = Path("data/projects")
DEFAULT_COLLAGES_DIR = Path("data/collages")
VIEWER_LOG_PATH = Path("data/logs/madnolia-viewer.log")
VIEWER_LOG_MAX_BYTES = 5 * 1024 * 1024
VIEWER_LOG_BACKUP_COUNT = 3
DEFAULT_VIEWER_HOST = "127.0.0.1"
DEFAULT_VIEWER_PORT = 8000
INSTALLED_MODE_MARKER = "installed.marker"
INSTALLED_DATA_DIRECTORY = "Madnolia"
INSTALLED_LOG_DIRECTORY = "logs"
LAUNCHER_ENVIRONMENT_VARIABLE = "MADNOLIA_LAUNCHER"
LAUNCHER_READY_TIMEOUT_SECONDS = 180
LAUNCHER_LOCK_FILE = "launcher.lock"
HEALTH_ENDPOINT = "/api/health"
APPLICATION_ID = "Madnolia"
OPENVINO_WORKER_ARGUMENT = "--openvino-worker"
HUGGINGFACE_CACHE_DIR = Path("data/cache/huggingface-hub")
TORCH_CACHE_DIR = Path("data/cache/torch")
GENERAL_CACHE_DIR = Path("data/cache")
NLTK_DATA_DIR = Path("data/cache/nltk")
DEFAULT_MODEL_NAME = "large-v3"
DEFAULT_ANALYSIS_BACKEND = "openvino"
DEFAULT_ANALYSIS_DEVICE = "GPU"
CUDA_DEVICE = "CUDA"
XPU_DEVICE = "XPU"
CUDA_BUNDLE_DIRECTORY = Path("_internal/cuda")
CUDA_BUNDLE_LIBRARY = "cublas64_12.dll"
CPU_DEVICE = "CPU"
GPU_VENDOR_PRIORITY = (
    ("VEN_10DE", "NVIDIA", "faster-whisper", CUDA_DEVICE),
    ("VEN_8086", "Intel", "openvino", "GPU"),
)
BACKEND_DEFAULT_DEVICES = {
    "openvino": "GPU",
    "faster-whisper": CPU_DEVICE,
    "qwen3-asr": CPU_DEVICE,
}
DEVICE_DEFAULT_BACKENDS = {
    "GPU": "openvino",
    XPU_DEVICE: "qwen3-asr",
    CPU_DEVICE: "faster-whisper",
    CUDA_DEVICE: "faster-whisper",
}
WINDOWS_PCI_REGISTRY_PATH = r"SYSTEM\CurrentControlSet\Enum\PCI"
WINDOWS_DISPLAY_CLASS_GUID = "{4d36e968-e325-11ce-bfc1-08002be10318}"
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
SEARCH_MAX_TARGET_SPAN = 8
SEARCH_MAX_EDIT_COUNT = 2
SEARCH_MAX_APPROXIMATE_ANCHORS_PER_SOURCE = 48
SEARCH_MAX_APPROXIMATE_RANKED_POOL_PER_TARGET_START = 32
SEARCH_INSERT_DELETE_COST = 0.72
SEARCH_MIN_SEQUENCE_SIMILARITY = 0.42
SEARCH_PRIMARY_APPROXIMATE_SIMILARITY = 0.68
SEARCH_PHONE_SIMILARITY_OVERRIDES = {
    frozenset(("ja.vowel.a", "ko.vowel.a")): 0.99,
    frozenset(("ja.vowel.i", "ko.vowel.i")): 0.99,
    frozenset(("ja.vowel.u", "ko.vowel.eu")): 0.97,
    frozenset(("ja.vowel.u", "ko.vowel.u")): 0.88,
    frozenset(("ja.vowel.e", "ko.vowel.e")): 0.99,
    frozenset(("ja.vowel.o", "ko.vowel.o")): 0.99,
    frozenset(("ja.consonant.velar.plosive.voiceless", "ko.consonant.velar.plosive.lenis")): 0.94,
    frozenset((
        "en.consonant.velar.plosive.voiced",
        "ko.consonant.velar.plosive.lenis",
    )): 0.92,
    frozenset((
        "en.consonant.velar.plosive.voiceless",
        "ko.consonant.velar.plosive.lenis",
    )): 0.94,
    frozenset((
        "ja.consonant.velar.plosive.voiced",
        "ko.consonant.velar.plosive.lenis",
    )): 0.92,
    frozenset((
        "en.consonant.alveolar.plosive.voiced",
        "ko.consonant.alveolar.plosive.lenis",
    )): 0.92,
    frozenset((
        "en.consonant.alveolar.plosive.voiceless",
        "ko.consonant.alveolar.plosive.lenis",
    )): 0.94,
    frozenset((
        "ja.consonant.alveolar.plosive.voiced",
        "ko.consonant.alveolar.plosive.lenis",
    )): 0.92,
    frozenset(("ja.consonant.alveolar.plosive.voiceless", "ko.consonant.alveolar.plosive.lenis")): 0.94,
    frozenset(("ja.consonant.alveolar.fricative.voiceless", "ko.consonant.alveolar.fricative.lenis")): 0.96,
    frozenset(("en.consonant.alveolar.fricative.voiceless", "ko.consonant.alveolar.fricative.lenis")): 0.96,
    frozenset(("en.consonant.alveolar.fricative.voiced", "ko.consonant.alveolar.fricative.lenis")): 0.92,
    frozenset(("ja.consonant.alveolopalatal.fricative.voiceless", "ko.consonant.alveolopalatal.fricative.lenis")): 0.97,
    frozenset(("ja.consonant.alveolopalatal.affricate.voiceless", "ko.consonant.alveolopalatal.affricate.aspirated")): 0.91,
    frozenset(("ja.consonant.alveolopalatal.affricate.voiced", "ko.consonant.alveolopalatal.affricate.lenis")): 0.90,
    frozenset(("en.consonant.postalveolar.affricate.voiceless", "ko.consonant.alveolopalatal.affricate.aspirated")): 0.91,
    frozenset(("en.consonant.postalveolar.affricate.voiced", "ko.consonant.alveolopalatal.affricate.lenis")): 0.90,
    frozenset(("ja.consonant.alveolar.affricate.voiceless", "ko.consonant.alveolopalatal.affricate.aspirated")): 0.82,
    frozenset(("ja.consonant.alveolar.fricative.voiced", "ko.consonant.alveolopalatal.affricate.lenis")): 0.82,
    frozenset(("ja.consonant.alveolar.nasal.voiced", "ko.consonant.alveolar.nasal")): 0.98,
    frozenset(("ja.consonant.velar.nasal.voiced", "ko.coda.velar.nasal")): 0.98,
    frozenset(("ja.consonant.glottal.fricative.voiceless", "ko.consonant.glottal.fricative")): 0.98,
    frozenset(("ja.consonant.bilabial.plosive.voiced", "ko.consonant.bilabial.plosive.lenis")): 0.92,
    frozenset(("ja.consonant.bilabial.plosive.voiceless", "ko.consonant.bilabial.plosive.lenis")): 0.88,
    frozenset(("en.consonant.bilabial.plosive.voiced", "ko.consonant.bilabial.plosive.lenis")): 0.92,
    frozenset(("en.consonant.bilabial.plosive.voiceless", "ko.consonant.bilabial.plosive.lenis")): 0.94,
    frozenset(("ja.consonant.bilabial.nasal.voiced", "ko.consonant.bilabial.nasal")): 0.98,
    frozenset(("ja.consonant.alveolar.tap.voiced", "ko.consonant.alveolar.tap")): 0.98,
    frozenset(("ja.consonant.labiovelar.approximant.voiced", "ko.vowel.wa")): 0.78,
    frozenset(("ja.consonant.palatal.approximant.voiced", "ko.vowel.ya")): 0.78,
    frozenset(("ja.consonant.palatalized.velar.plosive.voiceless", "ko.consonant.velar.plosive.lenis")): 0.84,
    frozenset(("ja.consonant.palatalized.velar.plosive.voiced", "ko.consonant.velar.plosive.lenis")): 0.86,
    frozenset(("ja.consonant.palatalized.alveolar.nasal.voiced", "ko.consonant.alveolar.nasal")): 0.86,
    frozenset(("ja.consonant.palatal.fricative.voiceless", "ko.consonant.glottal.fricative")): 0.80,
    frozenset(("ja.consonant.bilabial.fricative.voiceless", "ko.consonant.glottal.fricative")): 0.82,
    frozenset(("ja.consonant.palatalized.bilabial.nasal.voiced", "ko.consonant.bilabial.nasal")): 0.86,
    frozenset(("ja.consonant.palatalized.alveolar.tap.voiced", "ko.consonant.alveolar.tap")): 0.86,
    frozenset(("ja.consonant.palatalized.bilabial.plosive.voiced", "ko.consonant.bilabial.plosive.lenis")): 0.84,
    frozenset(("ja.consonant.palatalized.bilabial.plosive.voiceless", "ko.consonant.bilabial.plosive.aspirated")): 0.84,
    frozenset((
        "ja.consonant.uvular.nasal.voiced",
        "ko.coda.velar.nasal",
    )): 0.95,
    frozenset((
        "ja.consonant.uvular.nasal.voiced",
        "ko.consonant.alveolar.nasal",
    )): 0.90,
    frozenset((
        "ja.consonant.uvular.nasal.voiced",
        "ko.coda.bilabial.nasal",
    )): 0.86,
}
SEARCH_PHONE_FALLBACK_SIMILARITIES = {
    frozenset(("ja.consonant.labiodental.fricative.voiced", "ko.consonant.bilabial.plosive.lenis")): 0.64,
    frozenset(("ja.consonant.geminate", "ko.consonant.velar.plosive.fortis")): 0.64,
    frozenset(("ja.consonant.geminate", "ko.consonant.alveolar.plosive.fortis")): 0.64,
    frozenset(("ja.consonant.geminate", "ko.consonant.bilabial.plosive.fortis")): 0.64,
    frozenset(("ja.consonant.geminate", "ko.consonant.alveolar.fricative.fortis")): 0.62,
    frozenset(("ja.consonant.geminate", "ko.consonant.alveolopalatal.affricate.fortis")): 0.62,
    frozenset(("ja.consonant.palatal.approximant.voiced", "ko.vowel.yeo")): 0.62,
    frozenset(("ja.consonant.palatal.approximant.voiced", "ko.vowel.yo")): 0.62,
    frozenset(("ja.consonant.palatal.approximant.voiced", "ko.vowel.yu")): 0.62,
    frozenset(("ja.consonant.labiovelar.approximant.voiced", "ko.vowel.wo")): 0.62,
}
DEFAULT_CROSSFADE_MS = 8
MAX_CROSSFADE_MS = 100
MIN_STRETCH_PERCENT = 100
MAX_STRETCH_PERCENT = 150
PROFESSIONAL_MIN_DURATION_PERCENT = 1
PROFESSIONAL_MAX_DURATION_PERCENT = 3200
PROFESSIONAL_PITCH_MIN_CENTS = -2400
PROFESSIONAL_PITCH_MAX_CENTS = 2400
PROFESSIONAL_GAIN_MIN = 0.0
PROFESSIONAL_GAIN_MAX = 2.0
PROFESSIONAL_GAIN_DEFAULT = 1.0
PROFESSIONAL_ENVELOPE_POSITION_MIN = 0.0
PROFESSIONAL_ENVELOPE_POSITION_MAX = 1.0
PROFESSIONAL_ENVELOPE_POSITION_EPSILON = 2.220446049250313e-16
PROFESSIONAL_ENVELOPE_DEFAULT = ((0.0, PROFESSIONAL_GAIN_DEFAULT), (1.0, PROFESSIONAL_GAIN_DEFAULT))
PROFESSIONAL_COMPOSITION_SCHEMA_VERSION = 3
PROFESSIONAL_BEAT_DIVISIONS = (4, 8, 16, 24, 32, 48, 64, 96)
PROFESSIONAL_TEMPO_DEFAULT_BPM = 120
PROFESSIONAL_TEMPO_MIN_BPM = 20
PROFESSIONAL_TEMPO_MAX_BPM = 400
PROFESSIONAL_BEATS_PER_BAR_DEFAULT = 4
PROFESSIONAL_BEATS_PER_BAR_MIN = 1
PROFESSIONAL_BEATS_PER_BAR_MAX = 16
PROFESSIONAL_BEAT_DIVISION_DEFAULT = 4
PROFESSIONAL_GRID_OFFSET_UNITS_DEFAULT = 0
PROFESSIONAL_PHONE_CONTEXT_MAX_MS = 40
PROFESSIONAL_PHONE_BOUNDARY_BLEND_MS = 24
PITCH_MIN_MIDI = 24.0
PITCH_MAX_MIDI = 108.0
FORMANT_SHIFT_MIN_SEMITONES = -12.0
FORMANT_SHIFT_MAX_SEMITONES = 12.0
FORMANT_ENVELOPE_LIFTER = 18
FORMANT_GAIN_MIN = 0.25
FORMANT_GAIN_MAX = 4.0
PITCH_TRANSITION_DEFAULT_MS = 80
PITCH_TRANSITION_MAX_MS = 500
PITCH_TRANSITION_DEFAULT_STRENGTH = 100
PITCH_TRANSITION_CENTER_MIN_MS = -250
PITCH_TRANSITION_CENTER_MAX_MS = 250
PITCH_SHIFT_FRAME_SAMPLES = 640
PITCH_SHIFT_HOP_SAMPLES = 320
PROFESSIONAL_PITCH_SHIFT_MIN_SEMITONES = 1e-8
STRETCH_FRAME_SAMPLES = 320
STRETCH_SEARCH_SAMPLES = 64
OPENVINO_MODEL_REPOSITORIES = {
    "large-v3": "OpenVINO/whisper-large-v3-int8-ov",
    "large-v3-turbo": "OpenVINO/whisper-large-v3-turbo-int8-ov",
    "small": "OpenVINO/whisper-small-int8-ov",
}
QWEN_ASR_MODEL_REPOSITORIES = {
    "qwen3-asr-0.6b": "Qwen/Qwen3-ASR-0.6B-hf",
    "qwen3-asr-1.7b": "Qwen/Qwen3-ASR-1.7B-hf",
}
QWEN_ALIGNER_REPOSITORY = "Qwen/Qwen3-ForcedAligner-0.6B-hf"
QWEN_REQUIRED_MODEL_FILES = (
    "model.safetensors", "config.json", "processor_config.json",
    "tokenizer.json", "chat_template.jinja",
)
QWEN_AUDIO_CHUNK_SECONDS = 25
QWEN_AUDIO_OVERLAP_MS = 2000
QWEN_MAX_NEW_TOKENS = 256
QWEN_GPU_BATCH_SIZE = 2
FASTER_WHISPER_MODEL_REPOSITORIES = {
    "tiny": "Systran/faster-whisper-tiny",
    "base": "Systran/faster-whisper-base",
    "large-v3": "Systran/faster-whisper-large-v3",
    "large-v3-turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
    "small": "Systran/faster-whisper-small",
    "medium": "Systran/faster-whisper-medium",
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
VIDEO_UPLOAD_CHUNK_SIZE = 1024 * 1024
WINDOWS_RESERVED_FILENAME_PATTERN = r"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$"
SCHEMA_VERSION = "0.3.0"
ANALYSIS_VERSIONS_DIR = "versions"

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

ARPABET_IPA = {
    "AA": (("en.vowel.a", "ɑ"),),
    "AE": (("en.vowel.ae", "æ"),),
    "AH": (("en.vowel.eo", "ʌ"),),
    "AO": (("en.vowel.o", "ɔ"),),
    "AW": (("en.vowel.a", "a"), ("en.vowel.u", "ʊ")),
    "AY": (("en.vowel.a", "a"), ("en.vowel.i", "ɪ")),
    "EH": (("en.vowel.e", "ɛ"),),
    "ER": (("en.vowel.eo", "ɝ"),),
    "EY": (("en.vowel.e", "e"), ("en.vowel.i", "ɪ")),
    "IH": (("en.vowel.i", "ɪ"),),
    "IY": (("en.vowel.i", "i"),),
    "OW": (("en.vowel.o", "o"), ("en.vowel.u", "ʊ")),
    "OY": (("en.vowel.o", "ɔ"), ("en.vowel.i", "ɪ")),
    "UH": (("en.vowel.u", "ʊ"),),
    "UW": (("en.vowel.u", "u"),),
    "B": (("en.consonant.bilabial.plosive.voiced", "b"),),
    "CH": (("en.consonant.postalveolar.affricate.voiceless", "tʃ"),),
    "D": (("en.consonant.alveolar.plosive.voiced", "d"),),
    "DH": (("en.consonant.dental.fricative.voiced", "ð"),),
    "F": (("en.consonant.labiodental.fricative.voiceless", "f"),),
    "G": (("en.consonant.velar.plosive.voiced", "ɡ"),),
    "HH": (("en.consonant.glottal.fricative.voiceless", "h"),),
    "JH": (("en.consonant.postalveolar.affricate.voiced", "dʒ"),),
    "K": (("en.consonant.velar.plosive.voiceless", "k"),),
    "L": (("en.consonant.alveolar.lateral.voiced", "l"),),
    "M": (("en.consonant.bilabial.nasal.voiced", "m"),),
    "N": (("en.consonant.alveolar.nasal.voiced", "n"),),
    "NG": (("en.consonant.velar.nasal.voiced", "ŋ"),),
    "P": (("en.consonant.bilabial.plosive.voiceless", "p"),),
    "R": (("en.consonant.postalveolar.approximant.voiced", "ɹ"),),
    "S": (("en.consonant.alveolar.fricative.voiceless", "s"),),
    "SH": (("en.consonant.postalveolar.fricative.voiceless", "ʃ"),),
    "T": (("en.consonant.alveolar.plosive.voiceless", "t"),),
    "TH": (("en.consonant.dental.fricative.voiceless", "θ"),),
    "V": (("en.consonant.labiodental.fricative.voiced", "v"),),
    "W": (("en.consonant.labiovelar.approximant.voiced", "w"),),
    "Y": (("en.consonant.palatal.approximant.voiced", "j"),),
    "Z": (("en.consonant.alveolar.fricative.voiced", "z"),),
    "ZH": (("en.consonant.postalveolar.fricative.voiced", "ʒ"),),
}

JAPANESE_VOWELS = {
    "a": ("ja.vowel.a", "a"),
    "i": ("ja.vowel.i", "i"),
    "u": ("ja.vowel.u", "ɯ"),
    "e": ("ja.vowel.e", "e"),
    "o": ("ja.vowel.o", "o"),
}

JAPANESE_ONSETS = {
    "ky": ("ja.consonant.palatalized.velar.plosive.voiceless", "kʲ"),
    "gy": ("ja.consonant.palatalized.velar.plosive.voiced", "ɡʲ"),
    "sh": ("ja.consonant.alveolopalatal.fricative.voiceless", "ɕ"),
    "ch": ("ja.consonant.alveolopalatal.affricate.voiceless", "tɕ"),
    "ny": ("ja.consonant.palatalized.alveolar.nasal.voiced", "nʲ"),
    "hy": ("ja.consonant.palatal.fricative.voiceless", "ç"),
    "my": ("ja.consonant.palatalized.bilabial.nasal.voiced", "mʲ"),
    "ry": ("ja.consonant.palatalized.alveolar.tap.voiced", "ɾʲ"),
    "by": ("ja.consonant.palatalized.bilabial.plosive.voiced", "bʲ"),
    "py": ("ja.consonant.palatalized.bilabial.plosive.voiceless", "pʲ"),
    "ts": ("ja.consonant.alveolar.affricate.voiceless", "ts"),
    "j": ("ja.consonant.alveolopalatal.affricate.voiced", "dʑ"),
    "f": ("ja.consonant.bilabial.fricative.voiceless", "ɸ"),
    "v": ("ja.consonant.labiodental.fricative.voiced", "v"),
    "k": ("ja.consonant.velar.plosive.voiceless", "k"),
    "g": ("ja.consonant.velar.plosive.voiced", "ɡ"),
    "s": ("ja.consonant.alveolar.fricative.voiceless", "s"),
    "z": ("ja.consonant.alveolar.fricative.voiced", "z"),
    "t": ("ja.consonant.alveolar.plosive.voiceless", "t"),
    "d": ("ja.consonant.alveolar.plosive.voiced", "d"),
    "n": ("ja.consonant.alveolar.nasal.voiced", "n"),
    "h": ("ja.consonant.glottal.fricative.voiceless", "h"),
    "b": ("ja.consonant.bilabial.plosive.voiced", "b"),
    "p": ("ja.consonant.bilabial.plosive.voiceless", "p"),
    "m": ("ja.consonant.bilabial.nasal.voiced", "m"),
    "y": ("ja.consonant.palatal.approximant.voiced", "j"),
    "r": ("ja.consonant.alveolar.tap.voiced", "ɾ"),
    "w": ("ja.consonant.labiovelar.approximant.voiced", "w"),
}

JAPANESE_MORAIC_NASAL = ("ja.consonant.uvular.nasal.voiced", "ɴ")
JAPANESE_MORAIC_NASAL_VELAR = ("ja.consonant.velar.nasal.voiced", "ŋ")
JAPANESE_GEMINATE = ("ja.consonant.geminate", "Q")
