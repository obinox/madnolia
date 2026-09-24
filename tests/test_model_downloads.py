from types import SimpleNamespace

from madnolia import models
from madnolia.types.common import AlignmentMode, InferenceBackend


def test_missing_openvino_model_reports_downloaded_bytes(tmp_path, monkeypatch):
    monkeypatch.setattr(models, "MODEL_CACHE_DIR", tmp_path)
    files = [
        "openvino_encoder_model.xml",
        "openvino_encoder_model.bin",
        "openvino_decoder_model.xml",
        "openvino_decoder_model.bin",
        "openvino_tokenizer.xml",
        "openvino_tokenizer.bin",
        "openvino_detokenizer.xml",
        "openvino_detokenizer.bin",
        "config.json",
        "generation_config.json",
        "preprocessor_config.json",
        "tokenizer.json",
    ]
    monkeypatch.setattr(
        models,
        "model_info",
        lambda *args, **kwargs: SimpleNamespace(
            siblings=[SimpleNamespace(rfilename=name, size=4) for name in files],
        ),
    )
    requests = []

    def download(repository, filename, local_dir, tqdm_class):
        requests.append(filename)
        with tqdm_class(total=4, disable=True) as progress:
            progress.update(2)
            progress.update(2)
        target = local_dir / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"data")
        return str(target)

    monkeypatch.setattr(models, "hf_hub_download", download)
    progress = []
    options = ("large-v3", InferenceBackend.OPENVINO, [], AlignmentMode.ESTIMATED, False)
    models.ensure_analysis_models(
        *options, on_download=lambda name, percent: progress.append((name, percent))
    )
    assert set(requests) == set(files)
    assert any(0 < percent < 100 for _, percent in progress)
    assert progress[-1] == ("large-v3", 100.0)
    requests.clear()
    models.ensure_analysis_models(*options)
    assert requests == []
