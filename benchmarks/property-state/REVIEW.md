# Review protocol

## Reference admission

Inspect the actual pixels and the report section together. A photograph may support only part of a paragraph. Check continuation pages, image reuse and neighboring rows before pairing. Record a source locator, reviewer identity, date and limitation for each admitted case.

Include all **clear** visible faults within `taxonomy.json`; do not force labels for uncertain marks or normal minor weathering. A negative means no clear visible fault in this taxonomy within this particular image. It says nothing about the whole property, hidden construction, functionality or compliance. The source's absence of findings is insufficient.

Use these distinctions consistently:

- `cracking`: a fissure through material; `joint_or_sealant_defect`: an open or deteriorated designed junction.
- `material_loss`: visibly missing/eroded material or a detached surface layer; `damaged_component`: a discrete broken, torn or deformed component. Do not label the same manifestation twice just to cover synonyms.
- `displaced_component`: visible misalignment or an open lifted component, not an unverified claim about fastening strength.
- `coating_deterioration`: coating loss or peeling; it does not establish hidden timber rot.
- `moisture_staining`: visible stains with source moisture context; it does not establish current wetness or active leakage.
- `contamination`: visible substantive debris or deposits; it does not identify mould species or prove blocked drainage. Minor ordinary patina is not automatically a fault.
- Classify the affected object: window/door hardware and trim use `window_or_door`; standalone railings use `metalwork`; ceramic masonry sills use `masonry`; balcony walking surfaces use `floor`.

Keep source assertions about causes, measurements, function, urgency, costs, liability, asbestos and condition scores outside visual gold. Describe material loss instead of inferring concealed rot. Record contradictions explicitly. Never invent a room label when report headings disagree.

Native resolution and embedded annotations are part of the evidence quality. Enlarging a tiny image does not add information. Do not remove the marked fault or use report captions as model input. Exclude stock images, diagrams, signatures and report graphics from the scored set.

## Prediction adjudication

Review an unmatched finding against its claimed photos before assigning `unsupported` or `supported_additional`. Record reviewer and reason; preserve the prediction hash and finding index emitted by the scorer. An extra supported fault is a reference improvement candidate, not automatically a model hallucination. Avoid changing the frozen reference set midway through a comparison.

Assess prose separately, including findings that matched structured tags. The scorer does not certify the text. Use a sidecar review table keyed by run, case ID and finding index, with these independent ratings:

| Dimension | Ratings |
| --- | --- |
| Visible description | 2 = concrete and supported; 1 = vague or partly supported; 0 = incorrect |
| Evidence attribution | 2 = every cited image supports it; 1 = partly supported; 0 = unrelated images |
| Uncertainty | 2 = appropriately bounded; 1 = ambiguous wording; 0 = unwarranted certainty |
| Unsupported claims | List each asserted hidden cause, diagnosis, measurement, function, urgency, safety/compliance judgment, cost or liability without suitable evidence; otherwise `[]` |
| Grouping | Appropriate, duplicated, or incorrectly merged |

A confidently asserted foundation failure from a masonry crack is an unsupported claim even if the crack detection matches. A bathroom ventilation or electrical-performance judgment cannot be established from an ordinary RGB photograph. Record this separately from structured detection precision.

For a meaningful comparison, review outputs without seeing the model/provider identity, apply the same rubric to all runs and report reviewer counts, disagreements and unresolved decisions. This release has a single Codex reference reviewer, no inspector sign-off and no inter-rater agreement estimate.
