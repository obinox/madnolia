import numpy as np

from madnolia.acoustic_units import cluster_acoustic_units


def test_acoustic_units_separate_distant_embeddings() -> None:
    first = np.vstack([np.zeros((3, 4)), np.full((3, 4), 10.0)]).astype(np.float32)
    first[:3, 0] = 0.1
    unit_sets, centroids = cluster_acoustic_units([first], cluster_count=2, passes=2)
    units = unit_sets[0]
    assert len(set(units[:3])) == 1
    assert len(set(units[3:])) == 1
    assert units[0] != units[3]
    assert centroids.shape == (2, 4)
