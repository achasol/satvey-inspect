ALTER TABLE norm_assessments ADD COLUMN proposed_score integer CHECK(proposed_score BETWEEN 1 AND 6);
ALTER TABLE format_answers ADD COLUMN proposed_score integer CHECK(proposed_score BETWEEN 1 AND 6);
