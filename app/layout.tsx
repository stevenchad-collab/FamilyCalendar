import "./globals.css";

export const metadata = {
  title: "Family Calendar",
  description: "Shared, filterable family calendars",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
