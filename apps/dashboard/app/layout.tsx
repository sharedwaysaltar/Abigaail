import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Abigaail",
  description: "Abigaail: is everything OK right now?",
  robots: { index: false, follow: false },
  // Not no-referrer: that makes the browser send "Origin: null" on our own form posts.
  referrer: "same-origin",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
