export const metadata = { title: "Abigaail demo" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui", margin: "2rem" }}>{children}</body>
    </html>
  );
}
