import { DebugClient } from '@/components/DebugClient';
import { enabledInferenceProfiles } from '@/server/engine';

export const dynamic = 'force-dynamic';

export default function Home() {
  return <DebugClient availableInferenceProfiles={enabledInferenceProfiles()} />;
}
