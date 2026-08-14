type Shot = {
  src: string
  alt: string
  caption?: string
}

export function PhoneShot({ src, alt, caption }: Shot) {
  return (
    <figure className="not-prose m-0 flex flex-col items-center gap-2">
      <img
        src={src}
        alt={alt}
        className="w-full max-w-[240px] rounded-2xl border border-fd-border shadow-sm"
      />
      {caption ? <figcaption className="text-center text-sm text-fd-muted-foreground">{caption}</figcaption> : null}
    </figure>
  )
}

export function PhoneGallery({ shots }: { shots: Shot[] }) {
  return (
    <div className="not-prose my-8 grid grid-cols-2 gap-6 sm:grid-cols-4">
      {shots.map((shot) => (
        <PhoneShot key={shot.src} {...shot} />
      ))}
    </div>
  )
}
