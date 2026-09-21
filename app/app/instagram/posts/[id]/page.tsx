import { Review } from "../../_review";
export const metadata = { title: "Revisar postagem" };
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Review id={id} />;
}
