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
        
    import re
    # 1. Preserve tags like <laugh>, <sigh>, <whisper> by using Devanagari-safe placeholders
    tags = []
    def save_tag(match):
        tags.append(match.group(0))
        return f"९९९{len(tags)-1}९९९"
    
    text_with_placeholders = re.sub(r'<[a-zA-Z]+>', save_tag, text)
    
    # 2. Clean text: keep only Devanagari script, numbers, English letters, whitespaces, and basic punctuation.
    # This strips emojis and special symbols like ♪ to avoid synthesis corruption or audio glitches.
    cleaned_text = re.sub(r'[^\u0900-\u097F0-9a-zA-Z\s.,?!|\-।()\'":]', '', text_with_placeholders)
    cleaned_text = re.sub(r'\s+', ' ', cleaned_text).strip()
    
    # 3. Restore the preserved expression tags
    for i, tag in enumerate(tags):
        cleaned_text = cleaned_text.replace(f"९९९{i}९९९", tag)

    if not cleaned_text:
        cleaned_text = text

    print(f"Synthesizing text of length {len(cleaned_text)} (original: {len(text)}) using voice '{voice_name}'...")
    
    try:
        from supertonic import TTS
        
        # Instantiate TTS
        tts = TTS(auto_download=True)
        style = tts.get_voice_style(voice_name=voice_name)
        
        # Synthesize audio. lang="hi" is forced as per user request:
        # "use only hindi/hi in language no other voice"
        wav, duration = tts.synthesize(cleaned_text, voice_style=style, lang="hi")
        
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
