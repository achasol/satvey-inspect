# Property state benchmark v0.1

A standalone, local benchmark for identifying **visible property faults** and linking findings to photographs. It does not depend on the application, database, object store or a model provider.

The first release contains **51 reviewed cases using 43 unique pixel images**, from **10 reports and 9 providers**: 43 single-photo cases and 8 multi-photo cases. There are 60 single-photo reference finding instances and 74 instances across both tracks. Multi-photo cases reuse the single-photo evidence; these counts do not describe independent properties or unique physical defects. Development has 11 cases; evaluation has 40.

Labels were visually reviewed by Codex against extracted images and report context. They have **not been approved by a property inspector**. Treat results as exploratory comparative measurements. All sources have unresolved AI-reuse/redistribution status; downloaded reports and images remain local and ignored by Git.

## Use the existing dataset

Run these commands from this directory in PowerShell or another shell with Python 3.13:

```sh
python -m pip install -r requirements.txt
python dataset.py validate
python dataset.py review
```

The dataset is already materialized in `.local/inputs/`. The review command regenerates `.local/review/benchmark-booklet.pdf`, which displays every case with its reference findings, limitations and source locators.

Give the harness only:

- `.local/inputs/task.txt`: Dutch task instructions and the full taxonomy.
- `.local/inputs/development.jsonl` or `evaluation.jsonl`: neutral case IDs and image paths, relative to `.local/inputs/`.
- The referenced PNG files under `.local/inputs/images/`.

Each input row is `{"caseId":"c_…","photos":[{"photoId":"p_…","path":"images/p_….png"}]}`. The harness loads each image and supplies its photo ID alongside it. No report prose, source names, locations or diagnoses are included in model inputs. The harness may resize images, but must record that choice in run configuration. Keep prompts, preprocessing and budgets fixed when comparing models.

Store one JSON object per case in a predictions JSONL file. Each finding requires these fields:

```json
{"caseId":"c_…","findings":[{"title":"Scheur in metselwerk","description":"Een open scheur loopt door voegen en stenen.","faultType":"cracking","component":"masonry","photoIds":["p_…"]}]}
```

Use real IDs from the input file and exact codes from `taxonomy.json`. Without a clear visible fault, return `findings: []`. This differs from the app's optional generic overview finding: do not score an overview as a defect. No audio, report context, policy outcomes, bounding boxes or condition scores are required.

Create a run metadata JSON file such as:

```json
{"model":"provider/model-version","harness":"my-harness@commit","configuration":{"promptVersion":"v1","temperature":0,"maxOutputTokens":4096,"imagePreprocessing":"native PNG","seed":null}}
```

```sh
python score.py .local/predictions.jsonl --split evaluation --run-metadata .local/run.json --output .local/results/run-01.json
```

The scorer runs offline. It records the reference, taxonomy, scorer and prediction hashes. It never calls a model. `--split development` is useful while tuning; `--split all` is for diagnostics. Outputs for IDs outside the selected split are reported as unknown outputs. Missing or invalid case outputs retain their reference findings as false negatives.

## Read scores correctly

Detection uses maximum one-to-one matching on **fault type, component and an intersecting supporting photo ID**. Descriptions and titles are not compared as strings. Repeated findings cannot increase recall. Photo-attribution precision measures correct versus extra links on matched detections; attribution recall uses all reference links, including missed detections. Links from unmatched predictions are counted separately because they have no matched reference photo set. Exact attribution measures equality of the photo sets on matched findings. Canonical tag accuracy does not establish that the accompanying prose is correct.

An unmatched prediction may identify a real fault omitted by the starter labels. It enters a review queue instead of immediately becoming a false positive. Final precision and F1 remain `null` while any unmatched claims await adjudication; `provisional_reference_precision` is shown separately. Exact repeated tagged findings with the same photo set as a matched finding count as duplicate false positives.

Edit the generated `run-01.adjudications.jsonl`, retaining each row's `caseId`, `predictionHash` and `findingIndex`. Set `decision` to `unsupported` or `supported_additional`, and fill `reviewer` and `reason`. Then rerun:

```sh
python score.py .local/predictions.jsonl --adjudications .local/results/run-01.adjudications.jsonl --run-metadata .local/run.json --output .local/results/run-01-reviewed.json
```

Additional supported findings improve precision without expanding the frozen recall denominator. They should be considered for a later dataset revision. Adjudication is bound to the complete case prediction hash; changed predictions require renewed review. Invalid schema/taxonomy/photo references reject the whole case output and are counted explicitly.

Reports include source, provider, track, capture-modality, resolution and fault-type slices. **Compare single-photo and multi-photo tracks separately.** Overall counts combine overlapping evidence and are descriptive. One source photo contains an embedded red circle; its reference is flagged `embeddedMarkup`. Low-resolution means the native image's shorter side is below 256 pixels; that is a reporting flag, not an automatic admission threshold. The negative case count is only one, so it does not support a reliable false-alarm estimate.

Use [REVIEW.md](REVIEW.md) to assess description accuracy and unsupported claims. No automatic prose score or hidden-cause judgment is claimed.

## Existing app-shaped outputs

The app's `title`, `description`, `label` and `photoIds` shape lacks normalized fault/component tags. `adapt_app.py` accepts app-shaped outputs and a separate, explicitly assigned taxonomy-tag file. It does not read reference answers, infer tags from free text or call a judge.

A tag row is `{"caseId":"c_…","findingIndex":0,"faultType":"cracking","component":"masonry"}`. Assign tags from the prediction, without consulting gold, and record that tagging procedure when comparing harnesses. Empty findings need no tags. Audio evidence is rejected.

```sh
python adapt_app.py .local/app-outputs.jsonl .local/prediction-tags.jsonl .local/predictions.jsonl
```

For a new harness, requesting the normalized prediction contract directly avoids this manual tagging step. This benchmark does not change the app prompt, parser or APIs.

## Reproduce or extend extraction

```sh
python extract.py extract
python dataset.py build
python dataset.py validate
python -m unittest -v test_benchmark
```

Extraction reads `../../docs/benchmark-sources/source-details.json`. It retrieves the 12 candidate sources and inventories **every raster placement on every PDF page**, not just the catalogue's selected pages. The current retrieval contains 11 PDFs, 379 pages, 948 raster placements and 521 unique raster assets, including logos and other non-benchmark graphics. All 10 previously hashed PDF sources matched their catalogue hashes. Steeds, previously inaccessible, was recovered and pinned on first retrieval.

Original bytes are under `.local/reports/`; native RGB images under `.local/assets/`; text blocks/page coordinates under `.local/pages/`; and image placements in `.local/extraction.json`. Soft masks are composited against white. Native image dimensions are retained. Page crops are a documented fallback for inline images that have no extractable image object. Dates and annotations already embedded in an image are preserved; surrounding PDF text/watermarks are not part of the native embedded image. A source report's page position is physical and 1-based, not its printed page label.

Rebuilds use cached bytes. PDF hash changes are held for review, and a failed fetch cannot advance an existing pin. To check a fresh remote copy, move the cached source file aside and rerun extraction; changed bytes remain blocked until deliberately reviewed for a new release. Dynamic HTML is a retrieval snapshot, not a stable document identity.

DutchDetect's full-size page-8 RGB screenshot and thumbnail were retrieved and visually inspected. Its six embedded photographs, adjacent captions and measurement context remain outside this native-photo starter. The complete report and original photographs were not available. No thermal imagery is scored. The smaller MJOP comparison report is also held: its mixed photographic context does not establish clean whole-image negatives, and its no-defects summary conflicts with a visible cylinder on the roof.

`annotations.jsonl` is the authoritative reviewed curation input. `exclusions.jsonl` records inspected placements deliberately held out. To extend the benchmark, inspect images and their actual report sections, add reviewed annotations and exclusions, and rebuild. Generate source review sheets or page renders with:

```sh
python extract.py sheets bijn --pages 19 21 22
python extract.py page bijn 22
```

Pairing is deliberately not based on nearest text alone. NRBI has empty photo rows and page continuations; BIJN page 22 starts with timber photos from page 21; RoofSignal reuses images across observations. The VEH flashing photos are separate from the later painting row. `review-log.json` records these decisions. Generic advisory paragraphs, report scores, presumed causes and summary statements do not become labels automatically.

Rebuilding derives opaque case/photo IDs, exports input bundles, recomputes coverage and freezes hashes in `release.json`. Providers remain in one split; property links and exact/near duplicate image links can merge provider groups conservatively. Near matches constrain splits but never copy labels. The approximately 20/80 group split is deterministic: sort groups by SHA-256 of `property-state-0.1:<group>`, assign the first `ceil(0.2 * groups)` to development. It is not balanced by fault type. `.local/split-links.json` explains merges.

`coverage.json` reports actual counts, gaps, access states and the remaining review queue. Most extracted assets remain unreviewed. The release is strongest on exterior finishes, roofs and masonry; interior-room, moisture, sealant and negative coverage are sparse. Public report examples may have been seen during model pretraining. A private, inspector-approved property holdout is needed for stronger generalization claims.

No benchmark provider inference, publication or third-party upload was performed. Raw reports, source photographs, input bundles, review PDFs and result files are ignored by Git. Metadata-only checks work without downloading the source bytes:

```sh
python dataset.py validate --metadata-only
```
