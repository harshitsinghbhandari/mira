'use client'

import { useState } from 'react'
import { PTTTransmit } from '@/components/PTTTransmit'
import { AudioReceiver } from '@/components/AudioReceiver'

const WS_URL = process.env.NEXT_PUBLIC_RELAY_URL ?? 'ws://localhost:8080'

export default function TransmitPage() {
  const [channel, setChannel] = useState('ch-security')
  const [name, setName] = useState('Staff A')
  const [role, setRole] = useState<'send' | 'receive' | 'both'>('both')

  return (
    <main className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center gap-8 p-8">
      <div className="text-center">
        <h1 className="text-3xl font-bold">Mira — Voice Transmission Test</h1>
        <p className="text-gray-500 text-sm mt-1">
          Open this page in two tabs. One sends, one receives.
        </p>
      </div>

      <div className="flex gap-3 items-center flex-wrap justify-center">
        <select
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm"
        >
          <option value="ch-security">security</option>
          <option value="ch-medical">medical</option>
          <option value="ch-ops">operations</option>
        </select>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm w-32"
        />
        <div className="flex gap-1">
          {(['send', 'receive', 'both'] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRole(r)}
              className={`px-3 py-2 rounded-lg text-sm capitalize ${role === r ? 'bg-blue-600' : 'bg-gray-800'}`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-16 flex-wrap justify-center">
        {(role === 'send' || role === 'both') && (
          <div className="flex flex-col items-center gap-2">
            <p className="text-xs uppercase tracking-widest text-gray-600">Transmit</p>
            <PTTTransmit wsUrl={WS_URL} channelId={channel} senderName={name} />
          </div>
        )}
        {(role === 'receive' || role === 'both') && (
          <div className="flex flex-col items-center gap-2">
            <p className="text-xs uppercase tracking-widest text-gray-600">Receive</p>
            <AudioReceiver wsUrl={WS_URL} channelId={channel} />
          </div>
        )}
      </div>

      <p className="text-xs text-gray-700 text-center max-w-sm">
        Relay: <span className="font-mono text-gray-500">{WS_URL}</span>
      </p>
    </main>
  )
}
