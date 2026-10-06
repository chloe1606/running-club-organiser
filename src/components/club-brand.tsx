import Image from "next/image";
import Link from "next/link";

export function ClubBrand() {
  return <Link className="brand" href="/" aria-label="PETTS WOOD RUNNERS Tuesday Club Runs home">
    <Image className="brand-mark" src="/club-mark.svg" alt="" width={64} height={64} priority />
    <span className="brand-copy"><strong>PETTS WOOD RUNNERS</strong><span>Tuesday Club Runs</span></span>
  </Link>;
}