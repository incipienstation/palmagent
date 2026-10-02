# Synthetic video fixture

`blue-video.webm` is a four-second, 32 by 24 pixel blue clip without audio, generated
for attachment tests. It contains no user footage. Recreate it with FFmpeg:

```sh
ffmpeg -f lavfi -i 'color=c=blue:s=32x24:r=2:d=4' -c:v libvpx -an blue-video.webm
```

`blue-video.mp4` and `blue-video.mov` contain the same synthetic clip with H.264
video. Replace `-c:v libvpx` with `-c:v libx264 -pix_fmt yuv420p -movflags +faststart`
and change the output extension to recreate them.
