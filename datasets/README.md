# Local datasets

Runtime data is excluded from version control; this README is retained. Synthetic
redistributable development fixtures live in `tests/fixtures/`.

Production layout is `/data/workspaces/<workspace-id>/` with private source/staging
areas and immutable dataset versions. A local development root may be configured
under `datasets/`. Do not store credentials, generated sessions, or downloaded
Kaggle files in the source tree. Source versions, checksums and licensed-data
acquisition instructions must accompany reproducible evaluations.
