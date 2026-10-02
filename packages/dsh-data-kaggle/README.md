# dsh-data-kaggle

Managed dsh plugin for bounded Kaggle search/version resolution and constrained
official CLI downloads. Archive validation, source manifests and quarantine
support the reviewed ingestion pipeline. No general shell capability is exposed;
a downloaded source is not yet a published dataset.

Live acquisition requires the [pinned Kaggle CLI](../../tools/kaggle-cli/README.md)
and operator credentials. Tests use synthetic sources without credentials.

See [contracts](../../docs/contracts.md) and [current status](../../docs/implementation.md).
