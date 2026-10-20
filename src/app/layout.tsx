import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PETTS WOOD RUNNERS Tuesday Club Runs",
  description: "Book and manage your PETTS WOOD RUNNERS Tuesday club run.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const content = <><a className="skip-link" href="#content">Skip to content</a><div id="content">{children}</div></>;
  return (
    <html lang="en">
      <body>
        {process.env.CLUB_DEMO_MODE === "true" ? content :
          <ClerkProvider proxyUrl="/__clerk" signInUrl="/sign-in" signUpUrl="/sign-up">{content}</ClerkProvider>}
      </body>
    </html>
  );
}