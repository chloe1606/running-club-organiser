import { ClubPage } from "@/components/club-page";
export const dynamic = "force-dynamic";
export default async function GroupPage({ params }: { params: Promise<{ groupId: string }> }) {
  const { groupId } = await params;
  return <ClubPage view="detail" groupId={groupId} />;
}
