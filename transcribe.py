import sys
import os
import subprocess
import speech_recognition as sr

def main():
    if len(sys.argv) < 2:
        sys.stderr.write("Error: Missing audio file path argument.\n")
        sys.exit(1)

    input_path = sys.argv[1]
    if not os.path.exists(input_path):
        sys.stderr.write(f"Error: File not found: {input_path}\n")
        sys.exit(1)

    # Define intermediate WAV path
    wav_path = input_path + ".converted.wav"

    try:
        # Convert input audio (OGG/AAC/MP3) to standard mono 16kHz WAV using system ffmpeg
        # This is highly compatible with SpeechRecognition and runs silently
        cmd = [
            'ffmpeg',
            '-y',               # Overwrite file if exists
            '-i', input_path,   # Input file
            '-ac', '1',         # Mono audio
            '-ar', '16000',     # 16kHz sample rate
            wav_path
        ]
        
        # Run ffmpeg command silently
        result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
    except FileNotFoundError:
        sys.stderr.write("Error: FFmpeg is not installed or not found in system PATH. Please install FFmpeg to enable voice note transcription.\n")
        sys.exit(1)
    except subprocess.CalledProcessError as e:
        ffmpeg_err = e.stderr.decode('utf-8', errors='ignore') if e.stderr else str(e)
        sys.stderr.write(f"Error during audio conversion (FFmpeg failed): {ffmpeg_err}\n")
        if os.path.exists(wav_path):
            try:
                os.remove(wav_path)
            except:
                pass
        sys.exit(1)
    except Exception as e:
        sys.stderr.write(f"Error during audio conversion setup: {str(e)}\n")
        if os.path.exists(wav_path):
            try:
                os.remove(wav_path)
            except:
                pass
        sys.exit(1)

    try:
        # Initialize speech recognition engine
        r = sr.Recognizer()
        with sr.AudioFile(wav_path) as source:
            audio_data = r.record(source)
        
        # Perform transcription using free Google Speech recognizer
        text = r.recognize_google(audio_data)
        print(text.strip())
    except sr.UnknownValueError:
        # Could not understand audio (empty transcription is clean output)
        print("")
    except sr.RequestError as e:
        sys.stderr.write(f"Error: Speech service request failed: {str(e)}\n")
        sys.exit(1)
    finally:
        # Clean up intermediate WAV file
        if os.path.exists(wav_path):
            try:
                os.remove(wav_path)
            except:
                pass

if __name__ == '__main__':
    main()
