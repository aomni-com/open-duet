type YouTubeEmbedProps = {
  id: string
  title?: string
}

export function YouTubeEmbed({ id, title = 'YouTube video' }: YouTubeEmbedProps) {
  return (
    <div className="my-6 aspect-video w-full overflow-hidden rounded-lg border border-white/10">
      <iframe
        src={`https://www.youtube.com/embed/${id}`}
        title={title}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        className="h-full w-full"
      />
    </div>
  )
}
