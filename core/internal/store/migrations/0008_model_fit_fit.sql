-- Expert layers llama.cpp's fit kept on the GPU for an experts load (SPEC-core-seams.md, slice 6). Rows measured with
-- --cpu-moe, an f16 KV cache and -ub 512 would mislead under the new flags, so they go.
ALTER TABLE model_fit ADD COLUMN gpu_expert_layers INTEGER;  -- NULL: not known
DELETE FROM model_fit;
