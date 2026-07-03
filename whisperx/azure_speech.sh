#!/bin/bash
# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.
# -------------------------------------------------------------------------

# Set your Azure Speech Services endpoint and key
ENDPOINT="${AZURE_SPEECH_ENDPOINT:-https://fabian-test-2.cognitiveservices.azure.com/}"
API_KEY="${AZURE_SPEECH_KEY:-Coi**********************************RQc}"
AUDIO_FILE="${1:-sample.mp3}"

# -------------------------------------------------------------------------
# Optional fields in "definition":
#   - "transcribeStyle": control transcription style (e.g., "verbatim")
#   - "phraseList.phrases": bias transcription toward domain-specific terms
# Remove either field if you do not need it.
# -------------------------------------------------------------------------

curl --location "${ENDPOINT%/}/speechtotext/transcriptions:transcribe?api-version=2025-10-15" \
--header 'Content-Type: multipart/form-data' \
--header "Ocp-Apim-Subscription-Key: ${API_KEY}" \
--form "audio=@\"${AUDIO_FILE}\"" \
--form 'definition={
  "phraseList": {
    "phrases": ["Robotic", "Robotic Suite", "OEM", "ODM", "Fabian", "ARM", "ARK", "Oniverse", "Louis", "Cady", "Thor", "UniAI", "GenAI Studio", "Sim To Real", "Simulation", "Inference"]
  },
  "enhancedMode": {
    "enabled": true,
    "model": "mai-transcribe-1.5",
    "transcribeStyle": "verbatim"
  }
}'
