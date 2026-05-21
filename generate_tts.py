import sys
import io
import os

# Fix Windows console encoding issues for non-ASCII characters
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

def main():
    if len(sys.argv) < 4:
        print("Usage: python generate_tts.py <text_or_file> <voice_name> <output_path>")
        sys.exit(1)
        
    text_arg = sys.argv[1]
    voice_name = sys.argv[2]
    output_path = sys.argv[3]
    
    # Read text from file if the argument points to an existing text file
    if os.path.isfile(text_arg) and text_arg.endswith('.txt'):
        with open(text_arg, 'r', encoding='utf-8') as f:
            text = f.read().strip()
    else:
        text = text_arg
        
    print(f"Synthesizing text of length {len(text)} using voice '{voice_name}'...")
    
    try:
        from supertonic import TTS
        
        # Instantiate TTS
        tts = TTS(auto_download=True)
        style = tts.get_voice_style(voice_name=voice_name)
        
        # Synthesize audio. lang="hi" is forced as per user request:
        # "use only hindi/hi in language no other voice"
        wav, duration = tts.synthesize(text, voice_style=style, lang="hi")
        
        # Save output
        tts.save_audio(wav, output_path)
        
        # Format duration properly
        dur_val = 0.0
        try:
            if hasattr(duration, "__getitem__"):
                dur_val = float(duration[0])
            else:
                dur_val = float(duration)
        except Exception:
            dur_val = float(duration) if duration is not None else 0.0
            
        print(f"SUCCESS: Generated {dur_val:.2f}s of audio saved to {output_path}")
        sys.exit(0)
    except Exception as e:
        print(f"ERROR: {str(e)}")
        sys.exit(1)

if __name__ == "__main__":
    main()
