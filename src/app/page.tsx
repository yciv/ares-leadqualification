import Link from "next/link";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-3xl font-bold">ARES Lead Qualification</h1>
      <p className="text-gray-400">Autonomous B2B lead enrichment pipeline</p>
      <Link
        href="/projects/new"
        className="mt-4 rounded-lg bg-indigo-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500"
      >
        New Project
      </Link>
    </main>
  );
}
