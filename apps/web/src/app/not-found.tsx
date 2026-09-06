import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="mx-auto grid w-full max-w-2xl place-items-center px-4 py-24 text-center">
      <p className="mb-4 text-6xl" aria-hidden>🕹️</p>
      <h1 className="mb-3 text-3xl font-black text-ink">الصفحة غير موجودة</h1>
      <p className="mb-7 text-sm leading-8 text-muted">
        الرابط الذي فتحته لا يقود إلى لعبة أو صفحة هنا. ربما حُذفت، أو تغيّر عنوانها، أو أن العنوان كُتب بخطأ بسيط.
      </p>
      <div className="flex flex-wrap justify-center gap-2.5">
        <Link href="/" className="btn btn-primary">العودة للرئيسية</Link>
        <Link href="/games" className="btn btn-ghost">تصفّح الألعاب</Link>
        <Link href="/search" className="btn btn-ghost">البحث</Link>
      </div>
    </div>
  );
}
