import { motion } from "framer-motion";
import { Activity, Clock } from "lucide-react";

export const BenchmarkSection = () => {
  return (
    <section className="py-24 bg-secondary/30">
      <div className="container mx-auto px-4">
        <div className="mb-16 text-center">
          <h2 className="text-3xl font-bold mb-4">Performance Benchmarks</h2>
          <p className="text-muted-foreground max-w-2xl mx-auto">
            We benchmarked our core verification primitives. NilStore is designed to be unsealed: verification is cheap, and incentives come from serving speed (the Performance Market).
          </p>
        </div>

        <div className="grid lg:grid-cols-2 gap-12 items-center">
          <div className="space-y-8">
              <BenchmarkCard
                title="Verification Speed"
                value="< 1 ms"
                subtitle="Per Proof (Blob)"
                description="Verifying a KZG/Merkle proof is computationally trivial, allowing low-power devices to participate in consensus."
                icon={<ZapIcon className="w-6 h-6 text-yellow-500" />}
                barColor="bg-green-500"
                percentage={5} // Visual representation
              />
              <BenchmarkCard
                title="Sealing Latency"
                value="0s"
                subtitle="(No Sealing)"
                description="Providers don't precompute. They store bytes and compete to serve them quickly; slower adapters earn less in the Performance Market."
                icon={<Clock className="w-6 h-6 text-blue-500" />}
                barColor="bg-blue-600"
                percentage={0}
              />
            </div>

          <div className="bg-card p-8 rounded-3xl border shadow-lg">
            <h3 className="text-xl font-semibold mb-6 flex items-center gap-2">
              <Activity className="w-5 h-5 text-primary" /> Live Metrics (Simulated)
            </h3>
            <div className="space-y-6">
              <MetricRow label="Block Height" value="14,205" />
              <MetricRow label="Active Storage Nodes" value="128" />
              <MetricRow label="Total Data Stored" value="4.2 PB" />
              <MetricRow label="Average Proof Time" value="936 µs" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

interface BenchmarkCardProps {
  title: string
  value: string
  subtitle: string
  description: string
  icon: React.ReactNode
  barColor: string
  percentage: number
}

const BenchmarkCard = ({ title, value, subtitle, description, icon, barColor, percentage }: BenchmarkCardProps) => (
  <motion.div 
    initial={{ opacity: 0, x: -20 }}
    whileInView={{ opacity: 1, x: 0 }}
    viewport={{ once: true }}
    className="bg-background p-6 rounded-2xl border"
  >
    <div className="flex justify-between items-start mb-4">
      <div>
        <h3 className="text-lg font-semibold">{title}</h3>
        <div className="flex items-baseline gap-2 mt-1">
          <span className="text-3xl font-bold">{value}</span>
          <span className="text-sm text-muted-foreground">{subtitle}</span>
        </div>
      </div>
      <div className="p-2 bg-secondary rounded-lg">{icon}</div>
    </div>
    <div className="w-full bg-secondary h-2 rounded-full mb-4 overflow-hidden">
      <motion.div 
        initial={{ width: 0 }}
        whileInView={{ width: `${percentage}%` }}
        transition={{ duration: 1, delay: 0.5 }}
        className={`h-full ${barColor}`} 
      />
    </div>
    <p className="text-sm text-muted-foreground leading-relaxed">
      {description}
    </p>
  </motion.div>
);

const MetricRow = ({ label, value }: { label: string, value: string }) => (
  <div className="flex justify-between items-center py-3 border-b last:border-0">
    <span className="text-muted-foreground">{label}</span>
    <span className="font-mono font-medium">{value}</span>
  </div>
);

const ZapIcon = ({ className }: { className?: string }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
  </svg>
);
