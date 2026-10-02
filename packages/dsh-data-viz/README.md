# dsh-data-viz

Constrained chart intent validation, Vega-Lite templates, server SVG, PNG
rasterization, and the dsh `make_chart` toolview.

Supported templates are bar, line, point, area, heatmap, boxplot, histogram,
table, and KPI. The bounded intent also supports bar/area stacking, small
multiples, and a fixed two-measure line/area layer. Every encoding names a column
from the authorized query result; raw Vega specs, expressions, transforms, URLs,
scripts, and external data are rejected.

The host plugin registers `make_chart` (IDs only in model output) and, when
Connection is present, the authenticated `/api/analyst/artifacts` fetch route.
The browser half (`client.js`) registers a keyed tool card that displays the
SVG without putting markup in model context. It also owns the native Analysis
Studio sidebar, direct field/format controls, review handoffs and compact report
cards. See the [Studio guide](../../docs/analyst-studio-design.md).

See [contracts](../../docs/contracts.md) and [current status](../../docs/implementation.md).
