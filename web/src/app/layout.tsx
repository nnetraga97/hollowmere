import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { DesignTweaksOverlay } from '@/components/DesignTweaksOverlay';

import './globals.css';

export const metadata: Metadata = {
  title: 'Hollowmere — Town Instrument',
  description: 'A playable visual instrument for the Hollowmere multi-agent simulation.',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const showLocalDesignTweaks = process.env.NODE_ENV === 'development';

  return <html lang="en"><head><link rel="preload" as="image" href="/assets/hollowmere/location-atlas-v1.jpg" type="image/jpeg" /></head><body>{children}{showLocalDesignTweaks && <DesignTweaksOverlay />}</body></html>;
}
