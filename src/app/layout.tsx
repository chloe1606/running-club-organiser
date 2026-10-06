import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Petts Wood Runners Booking App",
  description: "Book your Tuesday evening club run.",
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
