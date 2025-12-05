import React, { useEffect, useState } from 'react';

interface Provider {
  address: string;
  total_storage: string;
  used_storage: string;
  capabilities: string;
  status: string;
}

export const Leaderboard: React.FC = () => {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('http://localhost:1317/nilchain/nilchain/v1/providers')
      .then(res => res.json())
      .then(data => {
        setProviders(data.providers || []);
        setLoading(false);
      })
      .catch(err => {
        console.error("Failed to fetch providers:", err);
        setLoading(false);
      });
  }, []);

  if (loading) return <div className="text-white">Loading Leaderboard...</div>;

  return (
    <div className="p-6 bg-gray-900 rounded-lg shadow-lg mt-8">
      <h2 className="text-3xl font-bold mb-6 text-white">Storage Providers Leaderboard</h2>
      <div className="overflow-x-auto">
        <table className="min-w-full bg-gray-800 border border-gray-700 rounded-md overflow-hidden">
          <thead>
            <tr className="bg-gray-700 text-gray-300 uppercase text-sm leading-normal">
              <th className="py-3 px-6 text-left">Address</th>
              <th className="py-3 px-6 text-left">Capabilities</th>
              <th className="py-3 px-6 text-right">Total Storage</th>
              <th className="py-3 px-6 text-right">Used Storage</th>
              <th className="py-3 px-6 text-center">Status</th>
            </tr>
          </thead>
          <tbody className="text-gray-300 text-sm font-light">
            {providers.length === 0 && (
                <tr><td colSpan={5} className="text-center py-4">No providers found.</td></tr>
            )}
            {providers.map((p) => (
              <tr key={p.address} className="border-b border-gray-700 hover:bg-gray-700">
                <td className="py-3 px-6 text-left font-mono whitespace-nowrap">{p.address}</td>
                <td className="py-3 px-6 text-left">{p.capabilities}</td>
                <td className="py-3 px-6 text-right">{p.total_storage}</td>
                <td className="py-3 px-6 text-right">{p.used_storage}</td>
                <td className="py-3 px-6 text-center">
                  <span className={`px-3 py-1 rounded-full text-xs ${p.status === 'Active' ? 'bg-green-500 text-green-900' : 'bg-red-500 text-red-900'}`}>
                    {p.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
