-- The engine build default is now "auto" (CUDA on an NVIDIA card once it is downloaded). A stored "bundled" was the
-- old default, not a choice, so it becomes "auto" once; a "bundled" picked after this stays.
UPDATE config SET value = json_set(value, '$.build', 'auto'), rev = rev + 1
  WHERE section = 'engine.llamaserver' AND json_extract(value, '$.build') = 'bundled';
