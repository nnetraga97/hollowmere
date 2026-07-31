ALTER TABLE worlds DROP CONSTRAINT IF EXISTS check_inference_profile;
ALTER TABLE worlds DROP CONSTRAINT IF EXISTS check_inference_profile_v2;
ALTER TABLE worlds DROP CONSTRAINT IF EXISTS worlds_inference_profile_check;
ALTER TABLE worlds DROP CONSTRAINT IF EXISTS check_inference_profile_v3;
ALTER TABLE worlds ADD CONSTRAINT check_inference_profile_v3
  CHECK (inference_profile IN ('stub', 'azure_sol', 'azure_terra', 'bedrock_sonnet'));
