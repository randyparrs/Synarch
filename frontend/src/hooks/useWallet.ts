import { useAccount, useDisconnect, useSwitchChain } from 'wagmi';
import { useConnectModal } from '@rainbow-me/rainbowkit';
import { genlayerChain, baseSepolia } from '../lib/wagmi';

/**
 * Wallet hook over wagmi + RainbowKit. One injected wallet (MetaMask, etc.)
 * signs on BOTH networks: GenLayer Studio Next (agents/judge) and Base Sepolia
 * (escrow/USDC). Components switch the chain per action.
 */
export function useWallet() {
  const { address, isConnected, chainId } = useAccount();
  const { disconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const { openConnectModal } = useConnectModal();

  const onGenLayer = chainId === genlayerChain.id;
  const onBase = chainId === baseSepolia.id;

  return {
    isConnected,
    address: (address ?? '') as string,
    chainId,
    onGenLayer,
    onBase,
    // Human network label for the header badge.
    networkName: onBase ? 'BASE SEPOLIA' : onGenLayer ? genlayerChain.name.toUpperCase() : (isConnected ? 'WRONG NETWORK' : 'NOT CONNECTED'),
    network: (onBase ? 'base' : 'genlayer') as 'base' | 'genlayer',
    connect: () => openConnectModal?.(),
    disconnect,
    switchToGenLayer: () => switchChainAsync({ chainId: genlayerChain.id }),
    switchToBase: () => switchChainAsync({ chainId: baseSepolia.id }),
  };
}
