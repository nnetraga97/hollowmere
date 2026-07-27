import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: 'Hollowmere — Town Instrument',
  description: 'A playable visual instrument for the Hollowmere multi-agent simulation.',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <html lang="en"><head><link rel="preload" as="image" href="/assets/hollowmere/location-atlas-v1.jpg" type="image/jpeg" /></head><body>{children}</body></html>;
}
