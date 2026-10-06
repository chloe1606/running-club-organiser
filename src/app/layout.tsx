import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Petts Wood Runners Tuesday Club Runs",
  description: "Book and manage your Petts Wood Runners Tuesday club run.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body><a className="skip-link" href="#content">Skip to content</a><div id="content">{children}</div></body>
    </html>
  );
}
