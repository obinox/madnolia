import numpy as np

from madnolia.ctc_alignment import _ctc_token_spans, _tokenize_ipa


def test_ipa_tokenizer_normalizes_korean_diacritics() -> None:
    vocab = {"k": 1, "tɕh": 2, "j": 3, "ʌ": 4}
    assert _tokenize_ipa("k̚", vocab) == ["k"]
    assert _tokenize_ipa("tɕʰ", vocab) == ["tɕh"]
    assert _tokenize_ipa("jʌ", vocab) == ["j", "ʌ"]


def test_ipa_tokenizer_maps_korean_ui_vowel() -> None:
    assert _tokenize_ipa("ɰi", {"ɯ": 1, "i": 2}) == ["ɯ", "i"]


def test_ctc_token_spans_finds_ordered_frames() -> None:
    probabilities = np.array(
        [
            [0.9, 0.1, 0.0],
            [0.1, 0.8, 0.1],
            [0.8, 0.1, 0.1],
            [0.1, 0.1, 0.8],
            [0.9, 0.05, 0.05],
        ],
        dtype=np.float32,
    )
    spans = _ctc_token_spans(np.log(probabilities + 1e-6), [1, 2], 0)
    assert spans is not None
    assert spans[0][:2] == (1, 2)
    assert spans[1][:2] == (3, 4)
