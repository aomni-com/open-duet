type VideoProps = {
  src: string
  alt?: string
  autoPlay?: boolean
  loop?: boolean
  muted?: boolean
  controls?: boolean
  poster?: string
}

export function Video({
  src,
  alt,
  autoPlay = true,
  loop = true,
  muted = true,
  controls = false,
  poster,
}: VideoProps) {
  return (
    <div className="my-6">
      <video
        src={src}
        autoPlay={autoPlay}
        loop={loop}
        muted={muted}
        controls={controls}
        playsInline
        poster={poster}
        className="w-full rounded-lg border border-white/10"
      >
        Your browser does not support the video tag.
      </video>
      {alt && <p className="mt-2 text-center text-sm text-muted-foreground">{alt}</p>}
    </div>
  )
}
