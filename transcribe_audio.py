"""Local CPU speech recognition fallback for WhatsApp audio (no API key needed)."""
import json
import os
import sys


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    if len(sys.argv) != 2:
        raise ValueError('Usage: python transcribe_audio.py <audio_file>')
    from faster_whisper import WhisperModel

    # Model files download once; subsequent voice notes use the local cache.
    model = WhisperModel(
        os.environ.get('LOCAL_STT_MODEL', 'small'),
        device='cpu',
        compute_type='int8',
        cpu_threads=int(os.environ.get('LOCAL_STT_THREADS', '2')),
    )
    segments, _ = model.transcribe(sys.argv[1], beam_size=1, vad_filter=True)
    text = ' '.join(segment.text.strip() for segment in segments).strip()
    print(json.dumps({'text': text}, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'Local speech recognition failed: {error}', file=sys.stderr)
        sys.exit(1)
