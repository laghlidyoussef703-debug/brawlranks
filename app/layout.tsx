import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BrawlRanks — Infrastructure Test",
  description:
    "Temporary infrastructure proof-of-concept scaffold for the BrawlRanks platform. Not the production site.",
  robots: {
    index: false,
    follow: false,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
